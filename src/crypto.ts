// The three cryptographic jobs the relay has, and nothing more.
//
//  1. Prove a caller is the device it claims to be, without the relay ever holding the proof.
//  2. Keep push tokens unusable to anyone who reads the database.
//  3. Count requests per IP address without ever storing an IP address.

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** What the `devices` table holds instead of a device's secret. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return toHex(new Uint8Array(digest));
}

/**
 * Compare two hex digests without letting the time taken say how much of them matched. Length is
 * allowed to leak: both sides are always SHA-256 digests, so it carries nothing.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * A stable, unguessable stand-in for an IP address, so a rate limit can be counted per caller
 * without the relay ever writing down who the caller is. Keyed with a Worker secret, so the mapping
 * cannot be reproduced by anyone holding the database — including us, after a key rotation.
 */
export async function ipKey(ip: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(ip));
  // Half the digest is plenty to separate callers, and a shorter row is a smaller thing to hold.
  return toHex(new Uint8Array(mac)).slice(0, 32);
}

async function tokenKey(secret: string): Promise<CryptoKey> {
  const raw = fromBase64(secret);
  if (raw.length !== 32) throw new Error('TOKEN_KEY must be 32 bytes, base64 encoded');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * Encrypt a push token for storage. The nonce is random per write and travels in front of the
 * ciphertext. A database dump therefore yields no token anyone can send to — the key lives only in
 * the Worker's secrets.
 */
export async function encryptToken(plain: string, secret: string): Promise<string> {
  const key = await tokenKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plain));
  const out = new Uint8Array(iv.length + sealed.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(sealed), iv.length);
  return toBase64(out);
}

/** Undo {@link encryptToken}. Returns null for anything that will not open, rather than throwing. */
export async function decryptToken(stored: string, secret: string): Promise<string | null> {
  try {
    const key = await tokenKey(secret);
    const raw = fromBase64(stored);
    const sealed = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.slice(0, 12) },
      key,
      raw.slice(12),
    );
    return new TextDecoder().decode(sealed);
  } catch {
    return null;
  }
}
