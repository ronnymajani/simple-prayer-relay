import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';

/**
 * A request as the edge delivers one. A plain `new Request()` is typed with the *init* shape of
 * `cf`, which the worker's `fetch` will not accept; this is the cast the Workers test docs use.
 */
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

export interface Device {
  deviceId: string;
  secret: string;
}

/** One request through the real worker, exactly as Cloudflare would deliver it. */
export async function call(
  path: string,
  // `cf` is omitted deliberately: with it in the init the request is typed as an *outgoing* one,
  // which the worker's fetch handler will not take.
  init: Omit<RequestInit, 'cf'> & { as?: Device; ip?: string } = {},
): Promise<Response> {
  const { as, ip, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set('content-type', 'application/json');
  // Every caller looks like a different address unless a test says otherwise, so one test's
  // requests cannot spend another test's rate limit.
  headers.set('cf-connecting-ip', ip ?? `10.0.0.${Math.floor(Math.random() * 250) + 1}`);
  if (as) headers.set('authorization', `Bearer ${as.deviceId}.${as.secret}`);

  const ctx = createExecutionContext();
  const response = await worker.fetch!(
    new IncomingRequest(`https://relay.simpleprayer.app${path}`, { ...rest, headers }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

export async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export async function newDevice(): Promise<Device> {
  const response = await call('/device', { method: 'POST' });
  return json<Device>(response);
}

/** Two devices, paired, as most tests need them. */
export async function newPair(): Promise<{ a: Device; b: Device; pairId: string }> {
  const a = await newDevice();
  const b = await newDevice();

  const invite = await json<{ code: string }>(await call('/invite', { method: 'POST', as: a }));
  const paired = await call('/pair', {
    method: 'POST',
    as: b,
    body: JSON.stringify({ code: invite.code }),
  });
  const { pairId } = await json<{ pairId: string }>(paired);

  return { a, b, pairId };
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function markBody(pairId: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    pairId,
    day: today(),
    prayer: 'maghrib',
    state: 'prayed',
    lang: 'en',
    notify: true,
    ...overrides,
  });
}

/** Give a device a push token, so the delivery paths are exercised rather than skipped. */
export async function setToken(device: Device, token = 'ExponentPushToken[test-token]'): Promise<Response> {
  return call('/device/token', {
    method: 'PUT',
    as: device,
    body: JSON.stringify({ pushToken: token }),
  });
}

export async function countRows(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}
