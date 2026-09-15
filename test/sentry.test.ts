// The privacy claim this relay makes is undone quietly, not loudly: not by someone adding a
// database table, but by a crash reporter helpfully attaching the request that failed. These are
// the tests that stand in the way of that.

import { describe, expect, it } from 'vitest';
import type { ErrorEvent } from '@sentry/core';
import { sentryOptions } from '../src/sentry';
import type { Env } from '../src/routes';

const env = (dsn?: string) => ({ SENTRY_DSN: dsn }) as unknown as Env;

function scrub(event: Partial<ErrorEvent>): ErrorEvent | null {
  const options = sentryOptions(env('https://key@o1.ingest.sentry.io/1'));
  const hook = options?.beforeSend;
  if (typeof hook !== 'function') throw new Error('beforeSend must be configured');
  return hook(event as ErrorEvent, {}) as ErrorEvent | null;
}

describe('sentry', () => {
  it('is not configured at all without a DSN, so tests and local runs report nowhere', () => {
    expect(sentryOptions(env(undefined))).toBeUndefined();
    expect(sentryOptions(env(''))).toBeUndefined();
  });

  it('sends no traces, no breadcrumbs and no default personal data', () => {
    const options = sentryOptions(env('https://key@o1.ingest.sentry.io/1'));
    expect(options?.tracesSampleRate).toBe(0);
    expect(options?.maxBreadcrumbs).toBe(0);
    expect(options?.sendDefaultPii).toBe(false);
    expect(options?.beforeBreadcrumb?.({}, {})).toBeNull();
    expect(options?.beforeSendTransaction?.({} as never, {})).toBeNull();
  });

  it('strips the request, which is where the caller headers and body would ride', () => {
    const event = scrub({
      request: {
        url: 'https://relay.simpleprayer.app/send',
        headers: { authorization: 'Bearer abc.def' },
        data: { pairId: 'x' },
      },
      user: { ip_address: '203.0.113.7' },
      server_name: 'relay',
      breadcrumbs: [{ message: 'POST /send' }],
    });

    expect(event?.request).toBeUndefined();
    expect(event?.user).toBeUndefined();
    expect(event?.server_name).toBeUndefined();
    expect(event?.breadcrumbs).toEqual([]);
  });

  it('redacts an id, a push token or an invite code that reached an error message', () => {
    const event = scrub({
      message: 'failed for device 0123456789abcdef0123456789abcdef with ABCD2345',
      exception: {
        values: [{ type: 'Error', value: 'token ExponentPushToken[abc-123] rejected' }],
      },
    });

    expect(event?.message).toBe('failed for device [id] with [code]');
    expect(event?.message).not.toContain('0123456789abcdef');
    expect(event?.exception?.values?.[0]?.value).toBe('token [push-token] rejected');
  });
});
