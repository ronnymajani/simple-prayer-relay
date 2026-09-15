// Sentry, for one purpose: to know when the relay is broken.
//
// It is configured to be nearly blind on purpose. The relay's whole claim is that it holds nothing
// about anybody, and a crash reporter is the classic way that claim quietly stops being true — a
// stack trace with the request attached, a breadcrumb trail, an IP recorded "for debugging". So the
// scrubbing below is not defensive tidiness; it is the claim being kept.
//
// What Sentry receives: an error type, a message, a stack trace, and which release it happened in.
// What it never receives: the request, its headers, its body, its URL, the caller's IP, any device
// id, pair id, invite code or push token, and any breadcrumb whatsoever.

import type { CloudflareOptions } from '@sentry/cloudflare';
import type { Env } from './routes';

/**
 * Hex ids, base64 secrets and invite codes should never reach an error message, but a message is
 * assembled from whatever threw, and a library we do not control could put one there. This is the
 * last thing that runs before an event leaves, so it is the right place to be paranoid.
 */
function redact(value: string): string {
  return value
    .replace(/\b[0-9a-f]{32}\b/g, '[id]')
    .replace(/Exponent?PushToken\[[^\]]*\]/g, '[push-token]')
    .replace(/\b[0-9A-HJKMNP-TV-Z]{8}\b/g, '[code]');
}

export function sentryOptions(env: Env): CloudflareOptions | undefined {
  // No DSN — in tests, and in any deployment that has not been given one — means no Sentry at all.
  if (!env.SENTRY_DSN) return undefined;

  return {
    dsn: env.SENTRY_DSN,

    // Errors only. A trace would record the shape of every request; a breadcrumb trail would record
    // the order they arrived in. Neither tells us the relay is broken, and both are a log.
    tracesSampleRate: 0,
    maxBreadcrumbs: 0,
    sendDefaultPii: false,

    beforeBreadcrumb: () => null,
    beforeSendTransaction: () => null,

    beforeSend(event) {
      // The request is the single richest thing Sentry would otherwise attach: URL, headers,
      // Authorization among them, query string, and the body. None of it goes.
      delete event.request;
      delete event.user;
      delete event.server_name;
      delete event.contexts?.trace;
      event.breadcrumbs = [];

      if (event.message) event.message = redact(event.message);
      for (const entry of event.exception?.values ?? []) {
        if (entry.value) entry.value = redact(entry.value);
      }

      return event;
    },
  };
}
