# Simple Prayer — buddy relay

This is the entire server side of [Simple Prayer](https://simpleprayer.app)'s buddy mode. It is
published so that anyone can check that it does what the app's privacy policy says it does.

The app itself is a prayer times and prayer tracking app that keeps everything on your phone. Buddy
mode is the one exception, and it is opt-in: if you and a friend both choose to, each of you can see
that the other prayed today. This service is what carries that between the two phones.

## What it does, in one paragraph

A phone tells the relay "the person I am paired with should know I prayed Maghrib". The relay puts
that one flag in the other phone's inbox and sends a push to wake it up. The other phone collects
the flag and the relay deletes it. If the phone never collects it, the relay deletes it after 24
hours anyway. That is the whole service.

## What it stores

Everything is in [`migrations/0001_init.sql`](migrations/0001_init.sql) — five tables, and the file
is commented for reading rather than for maintaining.

| table | what it is | how long it lives |
|---|---|---|
| `devices` | a random id, the SHA-256 of a secret the phone generated, and an encrypted push token | deleted when you turn buddy mode off; gone after 90 days of silence |
| `invites` | a one-time pairing code | 24 hours, or until it is used |
| `pairs` | two random device ids that agreed to see each other's flags | deleted when either of you unpairs; gone after 90 days of silence |
| `inbox` | one flag: a pair, a day, a prayer, and `prayed` or `cleared` | **deleted the moment the phone collects it, and after 24 hours regardless** |
| `quota` | counters for rate limiting, keyed by a device id or an HMAC of an IP | at most 24 hours |

There is no name, no email address, no phone number, no location, no account, no IP address, no user
agent, no language setting and no log line anywhere in it. If you dumped this database you would
learn which random identifiers are paired with which, and at most a day of "some device was told
that some pair prayed Maghrib". You could not tell whose phones they are, where they are, what
language they read, or anything about any prayer older than yesterday.

### Things it deliberately does not have

- **No logs.** Cloudflare's Workers Logs and Logpush are both off ([`wrangler.jsonc`](wrangler.jsonc)),
  and there is no `console.log` in the source. Errors go to Sentry with the request, the headers, the
  IP address and every identifier stripped out first — see [`src/sentry.ts`](src/sentry.ts) and the
  tests that pin it.
- **No push receipt polling.** Expo's delivery receipts are fetched by ticket id, which would mean
  keeping a row per push — "this device was told something at this time" — which is exactly the log
  this service promises not to keep.
- **No history.** The app shows you today and nothing else, so there is nothing older to store.
- **No admin endpoint and no search.** There is no way to ask this service who is paired with whom,
  including for us. The one listing endpoint, `GET /pairs`, returns only the caller's own link ids —
  never the other side's identifier — and exists so a phone can tell that its invite was taken and
  that a link it still shows has ended.

## What crosses the wire

One flag: `prayed`, or `cleared` when someone undoes a mark. Never "missed", never "not yet", never
an exemption, never a count or a streak. Your buddy's phone learns that you prayed; your silence
tells it nothing at all, which is the point — a blank row means "nothing arrived", not "they did not
pray", and there is no value in the protocol that could mean the second thing.

Nothing about who you are travels either. Your buddy's phone does not learn your name, and the relay
does not have one to give it. The icon, colour and nickname you see for a buddy are chosen by you,
on your phone, and stay there — so two paired people may picture each other completely differently.

The notification text is written by the **sending** phone, in the receiving phone's language, and
passed through. The relay holds no copy and no translations; it checks only that the text is short
and contains no link, so that one phone cannot use another's notification tray as a billboard.

## Security

- Every endpoint is scoped to the caller in SQL. "Not yours" and "does not exist" are both an empty
  404, so identifiers cannot be probed.
- A device authenticates with `Authorization: Bearer <device_id>.<secret>`. Only the SHA-256 of the
  secret is stored, and it is compared in constant time. The phone keeps the secret in the iOS
  keychain / Android keystore.
- Invite codes are 8 symbols of Crockford base32 — 2^40 — single use, valid 24 hours. Redeeming is
  rate limited to 5 attempts per 10 minutes and 20 per day per caller, on top of an edge limiter.
- Push tokens are AES-GCM encrypted with a key held only in the Worker's secrets, so a database dump
  yields nothing anyone can send to. Expo's enhanced push security is on, so a leaked token alone
  cannot be used either.
- Rate limits count per device, or per **HMAC of the IP address** with a Worker secret. Raw IP
  addresses are never written down.
- Bodies are capped at 2 KB and validated against a schema before any database work. Every statement
  is parameterised. Inbox writes upsert on `(device, pair, day, prayer)`, so a replayed request lands
  on the row that is already there instead of multiplying.
- HTTPS only, HSTS preloaded, `Cache-Control: no-store`, no cookies, and **no CORS header at all** —
  a missing header is what denies every origin, where `Access-Control-Allow-Origin: null` would have
  granted access to any null-origin context, sandboxed iframes included.
- Deliberately **no certificate pinning**: Cloudflare rotates its edge certificates, and a stale pin
  would silently break the feature for everyone.

If the relay is unreachable, the app shows blank buddy rows and tries again next time it is opened.
Nothing else in the app touches the network, so nothing else is affected.

## Running it

```sh
bun install
bun run test         # 56 tests against the real schema, no network
bun run typecheck

cp .dev.vars.example .dev.vars   # then fill it in
bun run db:local
bun run dev
```

Deploying needs a Cloudflare account, a D1 database (`wrangler d1 create simple-prayer-relay`, then
put its id in `wrangler.jsonc`), and four secrets:

```sh
wrangler secret put TOKEN_KEY          # openssl rand -base64 32
wrangler secret put IP_SECRET          # openssl rand -hex 32
wrangler secret put EXPO_ACCESS_TOKEN  # from expo.dev, with push permission
wrangler secret put SENTRY_DSN         # optional; without it, Sentry is not initialised at all
bun run db:remote
bun run deploy
```

## Licence

MIT — see [LICENSE](LICENSE). The Simple Prayer name and mark are not covered by it.
