// Who is calling. A device proves itself with an id and a secret it generated on the phone; the
// relay only ever holds the SHA-256 of that secret, so a database dump cannot be replayed as a
// caller. There is no session, no refresh, and nothing to sign in to.

import { getDevice, type DeviceRow } from './db';
import { sha256Hex, timingSafeEqual } from './crypto';
import { isId } from './validate';

export interface Caller {
  deviceId: string;
  device: DeviceRow;
}

/**
 * `Authorization: Bearer <device_id>.<secret>`. A malformed header is indistinguishable from a
 * wrong one to the caller: both end as 401 with no body.
 */
export function parseBearer(request: Request): { deviceId: string; secret: string } | null {
  const header = request.headers.get('authorization');
  if (!header) return null;

  const [scheme, value] = header.split(' ');
  if (!scheme || !value || scheme.toLowerCase() !== 'bearer') return null;

  const dot = value.indexOf('.');
  if (dot <= 0) return null;

  const deviceId = value.slice(0, dot);
  const secret = value.slice(dot + 1);
  if (!isId(deviceId) || secret.length < 16 || secret.length > 128) return null;

  return { deviceId, secret };
}

/**
 * Verify a caller. The hash comparison is constant-time so that a wrong secret cannot be narrowed
 * down by how long the answer took; the unknown-device path still costs a hash for the same reason,
 * rather than returning early on a missing row.
 */
export async function authenticate(db: D1Database, request: Request): Promise<Caller | null> {
  const parsed = parseBearer(request);
  if (!parsed) return null;

  const device = await getDevice(db, parsed.deviceId);
  const presented = await sha256Hex(parsed.secret);
  if (!device) return null;
  if (!timingSafeEqual(presented, device.secret_hash)) return null;

  return { deviceId: device.device_id, device };
}
