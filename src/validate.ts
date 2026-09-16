// Everything a caller sends is checked here, completely, before it reaches the database. A request
// that fails any of these is answered with a flat 400 and leaves no trace.

import { MARK_STATES, PRAYERS, type MarkState, type Prayer } from './protocol';

/** Big enough for any legitimate call and small enough that nothing can be smuggled in a body. */
export const MAX_BODY_BYTES = 2048;

const TITLE_MAX = 40;
const BODY_MAX = 120;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ID_PATTERN = /^[0-9a-f]{32}$/;
const LANG_PATTERN = /^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/;
const EXPO_TOKEN_PATTERN = /^(ExponentPushToken|ExpoPushToken)\[[^\]\s]{1,64}\]$/;

/** Control characters have no business in a notification, and a URL still less. */
const CONTROL = /[\p{Cc}\p{Cf}]/u;
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

  // Title and body arrive together or not at all: one without the other is a half-built
  // notification, and a visible push with no words is worse than a silent one.
  const hasTitle = raw.title !== undefined;
  const hasBody = raw.body !== undefined;
  if (hasTitle !== hasBody) return { ok: false, reason: 'title and body travel together' };
  if (hasTitle && !isDisplayText(raw.title, TITLE_MAX)) return { ok: false, reason: 'title' };
  if (hasBody && !isDisplayText(raw.body, BODY_MAX)) return { ok: false, reason: 'body' };

  // The named variant is an alternative body, so it lives under the same ceiling and the same
  // no-control-characters, no-URL rule. It is only ever meaningful alongside one: it is what the
  // receiving phone shows *instead of* `body` when it knows a nickname for this pair, and a
  // notification with no fallback is not one this relay will carry.
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
      ...(hasTitle ? { title: raw.title as string, body: raw.body as string } : {}),
      ...(hasNamed ? { bodyNamed: raw.bodyNamed as string } : {}),
    },
  };
}
