// Random identifiers. Everything the relay stores is one of these, which is why a database dump
// says so little: none of them is derived from anything about a person or a phone.

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** 128 bits of randomness as hex. Used for device ids, pair ids and inbox row ids. */
export function randomId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

/** 256 bits of randomness, base64url. Returned to a device once and never stored in the clear. */
export function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Crockford's base32: the ten digits plus the letters, less I, L, O and U. Nothing in it can be
// misread for anything else in it, and the letters it drops are exactly the ones a reader
// substitutes by ear (I and L for 1, O for zero) — which is what normalizeCode below undoes. 32
// symbols divides 256, so masking a random byte with 31 picks uniformly, with no modulo bias.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;

/**
 * A one-time invite code: 8 symbols, 2^40 possibilities. Shown to the user as ABCD-EFGH and stored
 * without the dash. The dash is presentation only — {@link normalizeCode} puts any spelling of it
 * back into the stored form.
 */
export function inviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b & 31];
  return out;
}

export function formatCode(code: string): string {
  return code.length === CODE_LENGTH ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/**
 * Accept what a person actually typed — lower case, spaces, dashes, and the substitutions a reader
 * makes by ear: I and L are heard as 1, O as zero. U is not in the alphabet and is not guessed at.
 * An unusable code returns null rather than a near miss, so /pair answers it exactly as it answers
 * a wrong one.
 */
export function normalizeCode(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  if (cleaned.length !== CODE_LENGTH) return null;
  for (const ch of cleaned) if (!CODE_ALPHABET.includes(ch)) return null;
  return cleaned;
}
