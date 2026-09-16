// The wire contract between the app and the relay.
//
// This file is duplicated, deliberately, in the app repo at the top of `src/domain/buddies.ts`. It is
// twenty lines that change about once a year, and sharing them through a published package would
// tie a store release to an npm version for no benefit. If you change anything here, change it
// there in the same week — and remember the old app version is still installed on phones, so add
// fields, never repurpose them.

export const PRAYERS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] as const;
export type Prayer = (typeof PRAYERS)[number];

/**
 * The entire vocabulary of the feature. `prayed` covers late as well — the app resolves lateness
 * before it sends, and a buddy is never told the difference. There is deliberately no value for
 * missed, for not-yet, for exempt or for a count: absence is not a state, and nothing here can be
 * made to express one.
 */
export const MARK_STATES = ['prayed', 'cleared'] as const;
export type MarkState = (typeof MARK_STATES)[number];

export type PushType = 'mark' | 'paired' | 'unpaired' | 'prefs';

/**
 * What one phone tells another about itself: the language to address it in, and whether it wants a
 * notification at all. Never stored — forwarded and forgotten, because the relay holds no language.
 */
export interface PrefsPayload {
  type: 'prefs';
  pairId: string;
  lang: string;
  notify: boolean;
}

/** What rides in a push's data, and what `GET /inbox` returns rows of. */
export interface MarkPayload {
  type: 'mark';
  pairId: string;
  day: string;
  prayer: Prayer;
  state: MarkState;
  /**
   * The sender's own language and notification preference, cached by the receiver so it can render
   * the next push in the right language and stay silent if asked. They travel with the flag rather
   * than living on the relay, which is how the relay holds no preference and no copy.
   */
  lang: string;
  notify: boolean;
  /**
   * The same sentence as the push's visible body, with the two characters `{}` standing where a
   * name would go — "{} has prayed.", already written in the receiver's language by the sender.
   *
   * The receiver's phone is the only place a nickname exists, so it is the only place that hole can
   * be filled: iOS does it in a notification service extension, Android in its messaging service,
   * both reading a map the app wrote to its own on-device storage. The relay never sees a nickname,
   * and a phone that has none for this pair simply shows the body it was sent.
   */
  bodyNamed?: string;
}

export interface PairEventPayload {
  type: 'paired' | 'unpaired';
  pairId: string;
}

export type BuddyPayload = MarkPayload | PairEventPayload | PrefsPayload;
