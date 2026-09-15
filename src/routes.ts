// Every endpoint the relay has. There are nine, and none of them can return a row belonging to
// anybody but the caller.
//
// Two conventions worth knowing before reading:
//   - "Not yours" and "does not exist" are both 404 with no body. The relay never confirms that an
//     identifier is real to someone who has no business with it, so ids cannot be probed.
//   - Nothing is logged. Not a request, not a failure, not an id. What went wrong reaches Sentry as
//     an error type and nothing else.

import {
  IDLE_TTL_MS,
  INBOX_TTL_MS,
  INVITE_TTL_MS,
  PAIR_LIMIT,
  ackInbox,
  bumpQuota,
  countPairs,
  createDevice,
  createInvite,
  createPair,
  deleteDevice,
  deletePair,
  findPairBetween,
  listInbox,
  listPairs,
  partnerIn,
  putInbox,
  setPushToken,
  takeInvite,
  touchDevice,
  touchPair,
} from './db';
import { encryptToken, ipKey, sha256Hex } from './crypto';
import { authenticate, type Caller } from './auth';
import { formatCode, inviteCode, normalizeCode, randomId, randomSecret } from './ids';
import { isExpoPushToken, isId, parseSendBody, MAX_BODY_BYTES } from './validate';
import { notifyMark, notifyPairEvent } from './push';

export interface Env {
  DB: D1Database;
  /** Burst protection at the edge; see wrangler.jsonc for the windows. */
  BURST_LIMITER: RateLimit;
  PAIR_LIMITER: RateLimit;
  /** 32 random bytes, base64. Encrypts push tokens at rest. */
  TOKEN_KEY: string;
  /** Keys the HMAC that stands in for an IP address in the quota table. */
  IP_SECRET: string;
  EXPO_ACCESS_TOKEN: string;
  SENTRY_DSN?: string;
}

const SECURITY_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
  // No CORS header at all. There is no browser client and never will be, and a *missing* header is
  // what actually denies every origin — `Access-Control-Allow-Origin: null` reads as permission to
  // any null-origin context, which includes sandboxed iframes and `file://` pages. Sending nothing
  // is both simpler and stricter.
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' },
  });
}

function empty(status: number): Response {
  return new Response(null, { status, headers: SECURITY_HEADERS });
}

/**
 * Read a JSON body, refusing anything oversized before it is parsed. Returns undefined for a body
 * that is absent or unparseable; every caller treats that as a 400.
 */
async function readJson(request: Request): Promise<unknown | undefined> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return undefined;

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return undefined;
  if (text.length === 0) return undefined;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function callerIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? '0.0.0.0';
}

/**
 * The edge limiter handles bursts (a minute at a time); the quota table handles the windows it
 * cannot express. Both are keyed by something unguessable — a device id, or an HMAC of the IP.
 */
async function burstOk(limiter: RateLimit, key: string): Promise<boolean> {
  const { success } = await limiter.limit({ key });
  return success;
}

// ---------------------------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------------------------

/**
 * A phone turning buddy mode on for the first time. It gets an id and a secret; we keep the id and
 * the secret's hash. This is the only unauthenticated write, so it is the one most tightly capped.
 */
async function postDevice(request: Request, env: Env, now: number): Promise<Response> {
  const ip = await ipKey(callerIp(request), env.IP_SECRET);
  if (!(await burstOk(env.BURST_LIMITER, ip))) return empty(429);
  if (!(await bumpQuota(env.DB, `dev:${ip}`, 10, 24 * 60 * 60 * 1000, now))) return empty(429);

  const deviceId = randomId();
  const secret = randomSecret();
  await createDevice(env.DB, deviceId, await sha256Hex(secret), now);

  // The only time the secret exists outside the phone. It is not stored, not logged, not recoverable.
  return json({ deviceId, secret }, 201);
}

async function putDeviceToken(
  request: Request,
  env: Env,
  caller: Caller,
  now: number,
): Promise<Response> {
  const body = await readJson(request);
  const token = (body as { pushToken?: unknown } | undefined)?.pushToken;
  if (!isExpoPushToken(token)) return empty(400);

  await setPushToken(env.DB, caller.deviceId, await encryptToken(token, env.TOKEN_KEY), now);
  return empty(204);
}

/** Turning buddy mode off. Takes everything with it — see `deleteDevice`. */
async function deleteDeviceRoute(env: Env, caller: Caller): Promise<Response> {
  await deleteDevice(env.DB, caller.deviceId);
  return empty(204);
}

// ---------------------------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------------------------

async function postInvite(env: Env, caller: Caller, now: number): Promise<Response> {
  if (!(await bumpQuota(env.DB, `inv:${caller.deviceId}`, 20, 24 * 60 * 60 * 1000, now))) {
    return empty(429);
  }
  if ((await countPairs(env.DB, caller.deviceId)) >= PAIR_LIMIT) return json({ error: 'full' }, 409);

  const code = inviteCode();
  const expiresAt = now + INVITE_TTL_MS;
  await createInvite(env.DB, code, caller.deviceId, expiresAt);
  await touchDevice(env.DB, caller.deviceId, now);

  return json({ code, display: formatCode(code), expiresAt }, 201);
}

/**
 * Redeem someone's code. This is the endpoint a guesser would attack, so it carries the strictest
 * limits in the relay: a burst window at the edge, five attempts per ten minutes per caller, and
 * twenty a day. Against 2^40 codes that is not a race anyone wins.
 */
async function postPair(request: Request, env: Env, caller: Caller, now: number): Promise<Response> {
  const ip = await ipKey(callerIp(request), env.IP_SECRET);
  if (!(await burstOk(env.PAIR_LIMITER, ip))) return empty(429);
  if (!(await bumpQuota(env.DB, `pair10:${ip}`, 5, 10 * 60 * 1000, now))) return empty(429);
  if (!(await bumpQuota(env.DB, `pair24:${ip}`, 20, 24 * 60 * 60 * 1000, now))) return empty(429);

  const body = await readJson(request);
  const raw = (body as { code?: unknown } | undefined)?.code;
  const code = typeof raw === 'string' ? normalizeCode(raw) : null;
  if (!code) return empty(400);

  if ((await countPairs(env.DB, caller.deviceId)) >= PAIR_LIMIT) return json({ error: 'full' }, 409);

  const inviterId = await takeInvite(env.DB, code, now);
  if (!inviterId) return empty(404);

  // Redeeming your own invite would make a buddy of yourself, which is a bug on the phone, not a
  // thing to support. The code is already spent by now — that is fine, it was ours.
  if (inviterId === caller.deviceId) return empty(409);

  if ((await countPairs(env.DB, inviterId)) >= PAIR_LIMIT) return json({ error: 'full' }, 409);

  const existing = await findPairBetween(env.DB, inviterId, caller.deviceId);
  if (existing) return json({ pairId: existing }, 200);

  const pairId = randomId();
  await createPair(env.DB, pairId, inviterId, caller.deviceId, now);
  await touchDevice(env.DB, caller.deviceId, now);

  // The inviter is told silently, so their app can stop showing the code and ask them what to call
  // their new buddy. No notification is shown for this.
  await notifyPairEvent(env, inviterId, { type: 'paired', pairId });

  return json({ pairId }, 201);
}

async function deletePairRoute(env: Env, caller: Caller, pairId: string): Promise<Response> {
  if (!isId(pairId)) return empty(400);

  const partner = await partnerIn(env.DB, pairId, caller.deviceId);
  if (!partner) return empty(404);

  await deletePair(env.DB, pairId);
  await notifyPairEvent(env, partner, { type: 'unpaired', pairId });

  return empty(204);
}

// ---------------------------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------------------------

/**
 * The one that matters. A flag goes into the other device's inbox and a push goes out to wake the
 * phone for it. The push is a doorbell: if it never arrives, or arrives and is swiped away, the
 * inbox still has the flag when the app next opens.
 */
async function postSend(request: Request, env: Env, caller: Caller, now: number): Promise<Response> {
  const body = await readJson(request);
  const parsed = parseSendBody(body, now);
  if (!parsed.ok) return empty(400);
  const send = parsed.value;

  const partner = await partnerIn(env.DB, send.pairId, caller.deviceId);
  if (!partner) return empty(404);

  // Five prayers, marked and unmarked a few times each, is nowhere near forty. A phone that reaches
  // this is looping, and the limit stops it costing the person on the other end their battery.
  if (!(await bumpQuota(env.DB, `send:${send.pairId}`, 40, 24 * 60 * 60 * 1000, now))) {
    return empty(429);
  }

  await putInbox(
    env.DB,
    {
      id: randomId(),
      toDevice: partner,
      pairId: send.pairId,
      day: send.day,
      prayer: send.prayer,
      state: send.state,
    },
    now + INBOX_TTL_MS,
  );
  await touchPair(env.DB, send.pairId, now);
  await touchDevice(env.DB, caller.deviceId, now);

  await notifyMark(env, partner, send);

  return empty(202);
}

/**
 * The caller's own links. Nothing about who they are with — just how many there are and their ids,
 * so a phone can tell that an invite was taken, and that a link it still lists has ended.
 */
async function getPairs(env: Env, caller: Caller, now: number): Promise<Response> {
  await touchDevice(env.DB, caller.deviceId, now);
  return json({ pairs: await listPairs(env.DB, caller.deviceId) });
}

async function getInbox(env: Env, caller: Caller, now: number): Promise<Response> {
  await touchDevice(env.DB, caller.deviceId, now);
  const rows = await listInbox(env.DB, caller.deviceId, now);
  return json({
    marks: rows.map((row) => ({
      id: row.id,
      pairId: row.pair_id,
      day: row.day,
      prayer: row.prayer,
      state: row.state,
    })),
  });
}

/** Collecting is deleting: once a phone says it has a flag, the relay stops having it. */
async function postInboxAck(request: Request, env: Env, caller: Caller): Promise<Response> {
  const body = await readJson(request);
  const ids = (body as { ids?: unknown } | undefined)?.ids;
  // D1 binds at most 100 parameters per statement, and `ackInbox` uses one per id plus the device.
  // Five buddies × five prayers is 25, so this is unreachable — but a limit above what the database
  // will accept is a limit that fails as an error rather than as a refusal.
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 99) return empty(400);
  if (!ids.every((id) => isId(id))) return empty(400);

  const removed = await ackInbox(env.DB, caller.deviceId, ids as string[]);
  return json({ removed });
}

// ---------------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------------

export async function route(request: Request, env: Env, now: number): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();

  // A plain, cheap, uninformative liveness check. It says nothing about the database on purpose.
  if (path === '/health' && method === 'GET') return json({ ok: true, ttl: IDLE_TTL_MS });

  if (path === '/device' && method === 'POST') return postDevice(request, env, now);

  const caller = await authenticate(env.DB, request);
  if (!caller) return empty(401);

  // One burst limit covering every authenticated route, rather than four of them remembering to
  // ask. D175 says "on every route" and it meant it: `/inbox` was pollable without limit (and each
  // call writes a `last_seen`), and `DELETE /pair/:id` fires a push at the other phone every time.
  // The tighter per-endpoint quotas below still apply on top of this.
  if (!(await burstOk(env.BURST_LIMITER, caller.deviceId))) return empty(429);

  if (path === '/device/token' && method === 'PUT') return putDeviceToken(request, env, caller, now);
  if (path === '/device' && method === 'DELETE') return deleteDeviceRoute(env, caller);
  if (path === '/invite' && method === 'POST') return postInvite(env, caller, now);
  if (path === '/pair' && method === 'POST') return postPair(request, env, caller, now);
  if (path === '/send' && method === 'POST') return postSend(request, env, caller, now);
  if (path === '/pairs' && method === 'GET') return getPairs(env, caller, now);
  if (path === '/inbox' && method === 'GET') return getInbox(env, caller, now);
  if (path === '/inbox/ack' && method === 'POST') return postInboxAck(request, env, caller);

  const pairId = /^\/pair\/([0-9a-f]{32})$/.exec(path)?.[1];
  if (pairId && method === 'DELETE') return deletePairRoute(env, caller, pairId);

  return empty(404);
}
