// Every statement the relay runs. Nothing else in the codebase touches D1 directly, so this file
// is the complete answer to "what can the relay possibly know".
//
// Two rules hold throughout:
//   - Every read is scoped to the calling device in SQL, not in TypeScript afterwards. A caller
//     cannot ask for a row that is not theirs, so there is no code path where forgetting a check
//     leaks one.
//   - Every write is parameterised. No statement is ever assembled from a caller's string.

import type { MarkState, Prayer } from './protocol';

export const PAIR_LIMIT = 5;
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
export const INBOX_TTL_MS = 24 * 60 * 60 * 1000;
export const IDLE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface DeviceRow {
  device_id: string;
  secret_hash: string;
  push_token: string | null;
}

export interface InboxRow {
  id: string;
  pair_id: string;
  day: string;
  prayer: Prayer;
  state: MarkState;
}

export async function createDevice(
  db: D1Database,
  deviceId: string,
  secretHash: string,
  now: number,
): Promise<void> {
  await db
    .prepare('INSERT INTO devices (device_id, secret_hash, push_token, last_seen) VALUES (?, ?, NULL, ?)')
    .bind(deviceId, secretHash, now)
    .run();
}

export async function getDevice(db: D1Database, deviceId: string): Promise<DeviceRow | null> {
  return db
    .prepare('SELECT device_id, secret_hash, push_token FROM devices WHERE device_id = ?')
    .bind(deviceId)
    .first<DeviceRow>();
}

export async function touchDevice(db: D1Database, deviceId: string, now: number): Promise<void> {
  await db.prepare('UPDATE devices SET last_seen = ? WHERE device_id = ?').bind(now, deviceId).run();
}

export async function setPushToken(
  db: D1Database,
  deviceId: string,
  encrypted: string,
  now: number,
): Promise<void> {
  await db
    .prepare('UPDATE devices SET push_token = ?, last_seen = ? WHERE device_id = ?')
    .bind(encrypted, now, deviceId)
    .run();
}

/**
 * Leaving buddy mode. Everything about the device goes at once: its own row, its invites, both
 * halves of every pair it is in, and every flag addressed to it. The buddies on the other side keep
 * nothing but their local nickname, and their next send will 404 and tell them the link is gone.
 */
export async function deleteDevice(db: D1Database, deviceId: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM inbox WHERE to_device = ?').bind(deviceId),
    db
      .prepare('DELETE FROM inbox WHERE pair_id IN (SELECT pair_id FROM pairs WHERE device_a = ?1 OR device_b = ?1)')
      .bind(deviceId),
    db.prepare('DELETE FROM pairs WHERE device_a = ?1 OR device_b = ?1').bind(deviceId),
    db.prepare('DELETE FROM invites WHERE device_id = ?').bind(deviceId),
    db.prepare('DELETE FROM devices WHERE device_id = ?').bind(deviceId),
  ]);
}

export async function createInvite(
  db: D1Database,
  code: string,
  deviceId: string,
  expiresAt: number,
): Promise<void> {
  await db
    .prepare('INSERT INTO invites (code, device_id, expires_at) VALUES (?, ?, ?)')
    .bind(code, deviceId, expiresAt)
    .run();
}

/**
 * Redeem a code: read it and delete it in one statement, so two people racing the same code cannot
 * both win it. An expired code is treated exactly as a wrong one.
 */
export async function takeInvite(db: D1Database, code: string, now: number): Promise<string | null> {
  const row = await db
    .prepare('DELETE FROM invites WHERE code = ? AND expires_at > ? RETURNING device_id')
    .bind(code, now)
    .first<{ device_id: string }>();
  return row?.device_id ?? null;
}

export async function countPairs(db: D1Database, deviceId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM pairs WHERE device_a = ?1 OR device_b = ?1')
    .bind(deviceId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Ids are stored in lexical order, so the UNIQUE key catches a repeat pairing from either side. */
export function orderPair(one: string, two: string): [string, string] {
  return one < two ? [one, two] : [two, one];
}

export async function findPairBetween(
  db: D1Database,
  one: string,
  two: string,
): Promise<string | null> {
  const [a, b] = orderPair(one, two);
  const row = await db
    .prepare('SELECT pair_id FROM pairs WHERE device_a = ? AND device_b = ?')
    .bind(a, b)
    .first<{ pair_id: string }>();
  return row?.pair_id ?? null;
}

export async function createPair(
  db: D1Database,
  pairId: string,
  one: string,
  two: string,
  now: number,
): Promise<void> {
  const [a, b] = orderPair(one, two);
  await db
    .prepare('INSERT INTO pairs (pair_id, device_a, device_b, last_used) VALUES (?, ?, ?, ?)')
    .bind(pairId, a, b, now)
    .run();
}

/**
 * The other side of a pair, but only if the caller is in it. A pair that exists and belongs to
 * someone else returns null, exactly as one that does not exist — the route turns both into the
 * same 404, so the relay never confirms that an id is real to someone who has no business with it.
 */
export async function partnerIn(
  db: D1Database,
  pairId: string,
  deviceId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      'SELECT device_a, device_b FROM pairs WHERE pair_id = ? AND (device_a = ?2 OR device_b = ?2)',
    )
    .bind(pairId, deviceId)
    .first<{ device_a: string; device_b: string }>();
  if (!row) return null;
  return row.device_a === deviceId ? row.device_b : row.device_a;
}

export async function touchPair(db: D1Database, pairId: string, now: number): Promise<void> {
  await db.prepare('UPDATE pairs SET last_used = ? WHERE pair_id = ?').bind(now, pairId).run();
}

/** Unpairing, from either side, and the flags in flight between them go with it. */
export async function deletePair(db: D1Database, pairId: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM inbox WHERE pair_id = ?').bind(pairId),
    db.prepare('DELETE FROM pairs WHERE pair_id = ?').bind(pairId),
  ]);
}

/**
 * Put one flag in a device's inbox. The UNIQUE key on (to_device, pair, day, prayer) means a
 * retried or replayed send lands on the row that is already there: the newest state wins and the
 * row count cannot grow. That is the whole of the replay defence — there is no ledger to keep.
 *
 * The conflict target is that UNIQUE constraint, so SQLite resolves it through its index rather
 * than by scanning. An upsert whose conflict target is *not* backed by an index reads the whole
 * table on every write, which on D1 shows up as a surprising `rows_read` bill.
 */
export async function putInbox(
  db: D1Database,
  row: { id: string; toDevice: string; pairId: string; day: string; prayer: Prayer; state: MarkState },
  expiresAt: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO inbox (id, to_device, pair_id, day, prayer, state, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (to_device, pair_id, day, prayer)
       DO UPDATE SET state = excluded.state, expires_at = excluded.expires_at`,
    )
    .bind(row.id, row.toDevice, row.pairId, row.day, row.prayer, row.state, expiresAt)
    .run();
}

export async function listInbox(
  db: D1Database,
  deviceId: string,
  now: number,
): Promise<InboxRow[]> {
  const result = await db
    .prepare(
      'SELECT id, pair_id, day, prayer, state FROM inbox WHERE to_device = ? AND expires_at > ? ORDER BY rowid',
    )
    .bind(deviceId, now)
    .all<InboxRow>();
  return result.results ?? [];
}

/**
 * Collecting is deleting. The `to_device` clause is what stops one device acknowledging — and so
 * destroying — another's flags.
 */
export async function ackInbox(db: D1Database, deviceId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const holes = ids.map(() => '?').join(', ');
  const result = await db
    .prepare(`DELETE FROM inbox WHERE to_device = ? AND id IN (${holes})`)
    .bind(deviceId, ...ids)
    .run();
  return result.meta.changes ?? 0;
}

/**
 * A counter with a window, for the limits the edge limiter cannot express (a day, ten minutes).
 * Returns false when the caller has had its allowance. The key is a device id or an HMAC of an IP —
 * never an IP.
 */
export async function bumpQuota(
  db: D1Database,
  key: string,
  limit: number,
  windowMs: number,
  now: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO quota (key, count, expires_at) VALUES (?1, 1, ?2)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN quota.expires_at <= ?3 THEN 1 ELSE quota.count + 1 END,
         expires_at = CASE WHEN quota.expires_at <= ?3 THEN ?2 ELSE quota.expires_at END
       RETURNING count`,
    )
    .bind(key, now + windowMs, now)
    .first<{ count: number }>();
  return (row?.count ?? limit + 1) <= limit;
}

/** The hourly sweep. Everything here is also deleted eagerly elsewhere; this is the backstop. */
export async function sweep(db: D1Database, now: number): Promise<void> {
  const idleBefore = now - IDLE_TTL_MS;
  await db.batch([
    db.prepare('DELETE FROM inbox WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM invites WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM quota WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM inbox WHERE pair_id IN (SELECT pair_id FROM pairs WHERE last_used <= ?)').bind(idleBefore),
    db.prepare('DELETE FROM pairs WHERE last_used <= ?').bind(idleBefore),
    db.prepare('DELETE FROM devices WHERE last_seen <= ?').bind(idleBefore),
    // A device that is gone cannot own a pair or an invite. Sweeping these by join keeps the
    // database from holding a pair whose other half no longer exists.
    db.prepare('DELETE FROM invites WHERE device_id NOT IN (SELECT device_id FROM devices)'),
    db
      .prepare(
        `DELETE FROM pairs WHERE device_a NOT IN (SELECT device_id FROM devices)
            OR device_b NOT IN (SELECT device_id FROM devices)`,
      ),
    db.prepare('DELETE FROM inbox WHERE to_device NOT IN (SELECT device_id FROM devices)'),
  ]);
}

/** Tokens the push service has told us are dead, and the pairs that pointed at them. */
export async function forgetPushToken(db: D1Database, deviceId: string): Promise<void> {
  await db.prepare('UPDATE devices SET push_token = NULL WHERE device_id = ?').bind(deviceId).run();
}
