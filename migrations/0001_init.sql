-- Simple Prayer buddy relay — the whole database.
--
-- Read this file as the privacy policy's proof. There is no name, no e-mail, no phone number, no
-- location, no IP address, no user agent, no language and no log line anywhere in it. Every key is
-- a random identifier generated on a phone or here. A full dump tells an attacker which random ids
-- are paired with which, and at most 24 hours of "some device was told that some pair prayed
-- Maghrib". That is the whole of it, and it is deliberate.

-- A device is one installation of the app that has turned buddy mode on.
-- `secret_hash` is SHA-256 of a 256-bit secret the device generated and keeps in its keychain; we
-- never hold the secret itself. `push_token` is the Expo push token, AES-GCM encrypted with a
-- Worker secret, so a database dump on its own yields nothing that can send a notification.
CREATE TABLE devices (
  device_id   TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  push_token  TEXT,
  last_seen   INTEGER NOT NULL
);
CREATE INDEX devices_last_seen ON devices (last_seen);

-- A one-time pairing code, valid for 24 hours, deleted the moment it is redeemed.
CREATE TABLE invites (
  code       TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX invites_device ON invites (device_id);
CREATE INDEX invites_expires ON invites (expires_at);

-- Two devices that have agreed to see each other's "prayed" flags. Symmetric: neither side is the
-- owner, and either can delete the row. The two ids are stored in lexical order so that the UNIQUE
-- key catches a second pairing of the same two devices whichever of them redeems the invite.
CREATE TABLE pairs (
  pair_id   TEXT PRIMARY KEY,
  device_a  TEXT NOT NULL,
  device_b  TEXT NOT NULL,
  last_used INTEGER NOT NULL,
  UNIQUE (device_a, device_b)
);
CREATE INDEX pairs_a ON pairs (device_a);
CREATE INDEX pairs_b ON pairs (device_b);
CREATE INDEX pairs_last_used ON pairs (last_used);

-- The only place a flag ever rests, and never for long: deleted the moment the receiving phone
-- acknowledges it, and expired 24 hours after it was written whatever happens. The UNIQUE key is
-- what makes a replayed send collapse into the row that is already there instead of multiplying.
CREATE TABLE inbox (
  id         TEXT PRIMARY KEY,
  to_device  TEXT NOT NULL,
  pair_id    TEXT NOT NULL,
  day        TEXT NOT NULL,
  prayer     TEXT NOT NULL,
  state      TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (to_device, pair_id, day, prayer)
);
CREATE INDEX inbox_to ON inbox (to_device);
CREATE INDEX inbox_expires ON inbox (expires_at);

-- Counters for the rate limits whose window is longer than the edge limiter can hold. The key is
-- either a device id or an HMAC of an IP address with a Worker secret — never an IP itself.
CREATE TABLE quota (
  key        TEXT PRIMARY KEY,
  count      INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX quota_expires ON quota (expires_at);
