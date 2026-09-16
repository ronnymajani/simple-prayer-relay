// Everything a caller sends is checked here, completely, before it reaches the database. A request
// that fails any of these is answered with a flat 400 and leaves no trace.

import { MARK_STATES, PRAYERS, type MarkState, type Prayer } from './protocol';

/** Big enough for any legitimate call and small enough that nothing can be smuggled in a body. */
export const MAX_BODY_BYTES = 2048;

const TITLE_MAX = 80;
const BODY_MAX = 120;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ID_PATTERN = /^[0-9a-f]{32}$/;
const LANG_PATTERN = /^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/;
const EXPO_TOKEN_PATTERN = /^(ExponentPushToken|ExpoPushToken)\[[^\]\s]{1,64}\]$/;

/**
 * Control characters have no business in a notification, and a URL still less.
 *
 * Format characters are refused too — with exactly one exception: the four bidi isolates
 * (U+2066–U+2069). Every interpolated value in the app is wrapped in those so that a Latin name
 * inside an Arabic sentence, or the reverse, keeps its place; refusing them would mean the sender
 * could not build "Leen prayed Dhuhr" with its own translation machinery. They are invisible, they
 * cannot spoof anything, and the rest of `\p{Cf}` (joiners, marks, tags) stays refused.
 */
const CONTROL = /[\p{Cc}]|(?![\u2066-\u2069])\p{Cf}/u;
const URLISH = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|app|link|me)\b)/i;

export function isPrayer(value: unknown): value is Prayer {
  return typeof value === 'string' && (PRAYERS as readonly string[]).includes(value);
}

export function isMarkState(value: unknown): value is MarkState {
  return typeof value === 'string' && (MARK_STATES as readonly string[]).includes(value);
}

export function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

export function isLanguage(value: unknown): value is string {
  return typeof value === 'string' && LANG_PATTERN.test(value);
}

export function isExpoPushToken(value: unknown): value is string {
  return typeof value === 'string' && EXPO_TOKEN_PATTERN.test(value);
}

/**
 * A prayer day, and a recent one. The window is deliberately generous — the sender's day boundary
 * is Fajr in their own timezone, which can sit a long way from UTC — but it is a window, so a flag
 * cannot be dated into next year and sit in an inbox that never expires.
 */
export function isRecentDay(value: unknown, now: number): value is string {
  if (typeof value !== 'string' || !DAY_PATTERN.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed)) return false;
  return Math.abs(parsed - now) / 86_400_000 <= 2;
}

/**
 * Notification text, which the *sending phone* wrote in the receiver's language. The relay cannot
 * read it and does not want to: it checks only that it is short, printable, and carries no link,
 * so one phone cannot use another's notification tray as a billboard.
 */
export function isDisplayText(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !CONTROL.test(value) &&
    !URLISH.test(value)
  );
}

export const TEXT_LIMITS = { title: TITLE_MAX, body: BODY_MAX } as const;

export interface SendBody {
  pairId: string;
  day: string;
  prayer: Prayer;
  state: MarkState;
  lang: string;
  notify: boolean;
  title?: string;
  body?: string;
  /** `title` with `{}` where the receiving phone puts its own nickname for the sender. */
  titleNamed?: string;
  /** The same for `body`. */
  bodyNamed?: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Parse a `POST /send` body. Returns the parsed value or a reason — the caller turns every reason
 * into the same flat 400, but naming them makes the tests read as claims.
 */
export function parseSendBody(input: unknown, now: number): Parsed<SendBody> {
  if (typeof input !== 'object' || input === null) return { ok: false, reason: 'not an object' };
  const raw = input as Record<string, unknown>;

  if (!isId(raw.pairId)) return { ok: false, reason: 'pairId' };
  if (!isRecentDay(raw.day, now)) return { ok: false, reason: 'day' };
  if (!isPrayer(raw.prayer)) return { ok: false, reason: 'prayer' };
  if (!isMarkState(raw.state)) return { ok: false, reason: 'state' };
  if (!isLanguage(raw.lang)) return { ok: false, reason: 'lang' };
  if (typeof raw.notify !== 'boolean') return { ok: false, reason: 'notify' };

  // A visible notification is a title. The body is optional — one true line is the whole message
  // ("Leen prayed Dhuhr") — but a body with no title is a notification with no first line, and
  // a visible push with no words is worse than a silent one.
  const hasTitle = raw.title !== undefined;
  const hasBody = raw.body !== undefined;
  if (hasBody && !hasTitle) return { ok: false, reason: 'body without title' };
  if (hasTitle && !isDisplayText(raw.title, TITLE_MAX)) return { ok: false, reason: 'title' };
  if (hasBody && !isDisplayText(raw.body, BODY_MAX)) return { ok: false, reason: 'body' };

  // The named variants are alternatives, so each lives under the same ceiling and the same rule
  // as the line it replaces, and each is only meaningful alongside that line: it is what the
  // receiving phone shows *instead of* it when it knows a nickname for this pair, and a
  // notification with no fallback is not one this relay will carry.
  const hasTitleNamed = raw.titleNamed !== undefined;
  if (hasTitleNamed && !hasTitle) return { ok: false, reason: 'titleNamed without title' };
  if (hasTitleNamed && !isDisplayText(raw.titleNamed, TITLE_MAX)) return { ok: false, reason: 'titleNamed' };
  const hasNamed = raw.bodyNamed !== undefined;
  if (hasNamed && !hasBody) return { ok: false, reason: 'bodyNamed without body' };
  if (hasNamed && !isDisplayText(raw.bodyNamed, BODY_MAX)) return { ok: false, reason: 'bodyNamed' };

  return {
    ok: true,
    value: {
      pairId: raw.pairId,
      day: raw.day,
      prayer: raw.prayer,
      state: raw.state,
      lang: raw.lang,
      notify: raw.notify,
      ...(hasTitle ? { title: raw.title as string } : {}),
      ...(hasBody ? { body: raw.body as string } : {}),
      ...(hasTitleNamed ? { titleNamed: raw.titleNamed as string } : {}),
      ...(hasNamed ? { bodyNamed: raw.bodyNamed as string } : {}),
    },
  };
}
