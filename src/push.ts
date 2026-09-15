// Waking the other phone.
//
// The relay does not decide what a notification says — it cannot, because it holds no language and
// no copy. The *sending* phone writes the title and body in the receiver's language and passes them
// through; the relay checks they are short and linkless and hands them to Expo. When the receiver
// has asked not to be told, the sender simply omits them and what goes out is a silent data push.
//
// A push is a doorbell, never the delivery. Everything here is best-effort: a failure is swallowed,
// because the flag is already in the inbox and the phone will collect it when it next opens.

import { forgetPushToken, getDevice } from './db';
import { decryptToken } from './crypto';
import type { BuddyPayload, MarkPayload } from './protocol';
import type { SendBody } from './validate';
import type { Env } from './routes';

const SEND_URL = 'https://exp.host/--/api/v2/push/send';

interface ExpoMessage {
  to: string;
  data: BuddyPayload;
  title?: string;
  body?: string;
  sound?: null;
  priority?: 'normal' | 'high';
  channelId?: string;
  categoryId?: string;
  ttl?: number;
  /** iOS: deliver to the app without showing anything. The whole silent path depends on it. */
  _contentAvailable?: boolean;
}

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

/** The app's Android channel for buddy marks — created on the phone, named here only to target it. */
const BUDDY_CHANNEL = 'buddies';
/** Matches the notification category the app registers, which carries the "Prayed" button. */
const BUDDY_CATEGORY = 'buddy';

/**
 * A flag is worth a day at most: after that the app will have collected it from the inbox anyway,
 * and a push arriving later would announce a prayer from yesterday.
 */
const PUSH_TTL_SECONDS = 6 * 60 * 60;

function authHeaders(env: Env): Record<string, string> {
  return {
    // Expo's enhanced push security: without this token a leaked push token cannot be sent to, which
    // is the point of encrypting them at rest in the first place.
    authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}`,
    'content-type': 'application/json',
    accept: 'application/json',
    'accept-encoding': 'gzip, deflate',
  };
}

async function tokenFor(env: Env, deviceId: string): Promise<string | null> {
  // No Expo token configured means no push service to talk to — local development and the test
  // suite both run this way, and neither should be reaching out to the network.
  if (!env.EXPO_ACCESS_TOKEN) return null;

  const device = await getDevice(env.DB, deviceId);
  if (!device?.push_token) return null;
  return decryptToken(device.push_token, env.TOKEN_KEY);
}

/**
 * Post one message and act on what comes back. A token Expo reports as dead is cleared, so the
 * hourly sweep can retire the device rather than pushing at a phone that uninstalled the app.
 */
async function deliver(env: Env, deviceId: string, message: ExpoMessage): Promise<void> {
  const response = await fetch(SEND_URL, {
    method: 'POST',
    headers: authHeaders(env),
    body: JSON.stringify(message),
  });

  if (!response.ok) return;

  const payload = (await response.json()) as { data?: ExpoTicket | ExpoTicket[] };
  const tickets = Array.isArray(payload.data) ? payload.data : payload.data ? [payload.data] : [];

  for (const ticket of tickets) {
    if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
      await forgetPushToken(env.DB, deviceId);
    }
  }
}

/** Never let a push problem become the caller's problem: the inbox already has the flag. */
async function attempt(work: Promise<void>): Promise<void> {
  try {
    await work;
  } catch {
    // Swallowed on purpose. Sentry sees unhandled errors; this one is handled, and noisy.
  }
}

/**
 * Tell a device that its buddy prayed — or that they undid it, which is always silent: a retraction
 * is a correction, and nobody needs to be told twice about one prayer.
 */
export async function notifyMark(env: Env, toDeviceId: string, send: SendBody): Promise<void> {
  await attempt(
    (async () => {
      const token = await tokenFor(env, toDeviceId);
      if (!token) return;

      const data: MarkPayload = {
        type: 'mark',
        pairId: send.pairId,
        day: send.day,
        prayer: send.prayer,
        state: send.state,
        lang: send.lang,
        notify: send.notify,
      };

      const visible = send.state === 'prayed' && send.title !== undefined && send.body !== undefined;

      await deliver(env, toDeviceId, {
        to: token,
        data,
        ttl: PUSH_TTL_SECONDS,
        ...(visible
          ? {
              title: send.title,
              body: send.body,
              // Silent in the tray but visible on the screen: no sound, no vibration, and the
              // category that carries the app's own "Prayed" button.
              sound: null,
              priority: 'normal',
              channelId: BUDDY_CHANNEL,
              categoryId: BUDDY_CATEGORY,
            }
          : { _contentAvailable: true, priority: 'normal' }),
      });
    })(),
  );
}

/** Pairing and unpairing are always silent — the app decides what, if anything, to show. */
export async function notifyPairEvent(
  env: Env,
  toDeviceId: string,
  payload: BuddyPayload,
): Promise<void> {
  await attempt(
    (async () => {
      const token = await tokenFor(env, toDeviceId);
      if (!token) return;
      await deliver(env, toDeviceId, {
        to: token,
        data: payload,
        _contentAvailable: true,
        priority: 'normal',
        ttl: PUSH_TTL_SECONDS,
      });
    })(),
  );
}

// There is deliberately no receipt polling. Expo's receipts are fetched by ticket id, which would
// mean storing a row per push — "device X was told something at time T" — which is precisely the
// log this relay promises not to keep. The send-time ticket already reports DeviceNotRegistered for
// a token the push services have retired, which is the only outcome worth acting on; a token that
// dies later is cleared on the next send to it, and the 90-day sweep takes the rest.
