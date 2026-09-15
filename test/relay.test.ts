// What the relay must do, and — more of this file — what it must refuse to do.
//
// The claims worth reading first are in "one device cannot touch another's anything": those are the
// tests that stand between a stranger and somebody's prayer flags.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  call,
  countRows,
  json,
  markBody,
  newDevice,
  newPair,
  setToken,
  today,
} from './helpers';
import { sweep } from '../src/db';

describe('health', () => {
  it('answers without a database or a caller', async () => {
    const response = await call('/health');
    expect(response.status).toBe(200);
  });

  it('refuses a route that does not exist, without saying anything about it', async () => {
    const response = await call('/admin');
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('');
  });
});

describe('devices', () => {
  it('hands out an id and a secret, and keeps only the hash of the secret', async () => {
    const device = await newDevice();
    expect(device.deviceId).toMatch(/^[0-9a-f]{32}$/);
    expect(device.secret.length).toBeGreaterThanOrEqual(32);

    const row = await env.DB.prepare('SELECT secret_hash FROM devices WHERE device_id = ?')
      .bind(device.deviceId)
      .first<{ secret_hash: string }>();
    expect(row?.secret_hash).toBeTruthy();
    expect(row?.secret_hash).not.toBe(device.secret);
  });

  it('turns away a wrong secret, an unknown device and a malformed header alike', async () => {
    const device = await newDevice();

    expect((await call('/inbox', { as: { ...device, secret: 'wrong-secret-value' } })).status).toBe(401);
    expect((await call('/inbox', { as: { deviceId: 'f'.repeat(32), secret: device.secret } })).status).toBe(401);
    expect((await call('/inbox', { headers: { authorization: 'Basic nope' } })).status).toBe(401);
    expect((await call('/inbox')).status).toBe(401);
  });

  it('stores a push token encrypted, so the database alone cannot send to anybody', async () => {
    const device = await newDevice();
    expect((await setToken(device)).status).toBe(204);

    const row = await env.DB.prepare('SELECT push_token FROM devices WHERE device_id = ?')
      .bind(device.deviceId)
      .first<{ push_token: string }>();
    expect(row?.push_token).toBeTruthy();
    expect(row?.push_token).not.toContain('ExponentPushToken');
  });

  it('refuses anything that is not an Expo push token', async () => {
    const device = await newDevice();
    const response = await call('/device/token', {
      method: 'PUT',
      as: device,
      body: JSON.stringify({ pushToken: 'https://example.com/webhook' }),
    });
    expect(response.status).toBe(400);
  });

  it('leaving buddy mode takes the device, its pairs and its flags with it', async () => {
    const { a, b, pairId } = await newPair();
    await call('/send', { method: 'POST', as: a, body: markBody(pairId) });

    expect((await call('/device', { method: 'DELETE', as: a })).status).toBe(204);

    expect(await countRows('devices')).toBe(1);
    expect(await countRows('pairs')).toBe(0);
    expect(await countRows('inbox')).toBe(0);
    // The one left behind still works; their next send simply finds no pair.
    expect((await call('/inbox', { as: b })).status).toBe(200);
  });
});

describe('pairing', () => {
  it('pairs two devices through a one-time code', async () => {
    const { pairId } = await newPair();
    expect(pairId).toMatch(/^[0-9a-f]{32}$/);
    expect(await countRows('pairs')).toBe(1);
    // Redeeming spends the code.
    expect(await countRows('invites')).toBe(0);
  });

  it('accepts the code however a person types it', async () => {
    const a = await newDevice();
    const b = await newDevice();
    const { code } = await json<{ code: string }>(await call('/invite', { method: 'POST', as: a }));

    // Lower case, with the display dash, and with I and O heard for 1 and 0.
    const typed = `${code.slice(0, 4)}-${code.slice(4)}`
      .toLowerCase()
      .replace(/1/g, 'l')
      .replace(/0/g, 'o');

    const response = await call('/pair', { method: 'POST', as: b, body: JSON.stringify({ code: typed }) });
    expect(response.status).toBe(201);
  });

  it('refuses a code that was already used', async () => {
    const a = await newDevice();
    const b = await newDevice();
    const c = await newDevice();
    const { code } = await json<{ code: string }>(await call('/invite', { method: 'POST', as: a }));

    expect((await call('/pair', { method: 'POST', as: b, body: JSON.stringify({ code }) })).status).toBe(201);
    expect((await call('/pair', { method: 'POST', as: c, body: JSON.stringify({ code }) })).status).toBe(404);
  });

  it('refuses a code redeemed by the person who made it', async () => {
    const a = await newDevice();
    const { code } = await json<{ code: string }>(await call('/invite', { method: 'POST', as: a }));

    const response = await call('/pair', { method: 'POST', as: a, body: JSON.stringify({ code }) });
    expect(response.status).toBe(409);
    expect(await countRows('pairs')).toBe(0);
  });

  it('answers a wrong code exactly as it answers an expired one', async () => {
    const b = await newDevice();
    const response = await call('/pair', { method: 'POST', as: b, body: JSON.stringify({ code: 'ABCD2345' }) });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
  });

  it('pairing the same two devices twice returns the pair they already have', async () => {
    const { a, b, pairId } = await newPair();
    const { code } = await json<{ code: string }>(await call('/invite', { method: 'POST', as: a }));

    const again = await call('/pair', { method: 'POST', as: b, body: JSON.stringify({ code }) });
    expect(again.status).toBe(200);
    expect((await json<{ pairId: string }>(again)).pairId).toBe(pairId);
    expect(await countRows('pairs')).toBe(1);
  });

  it('stops at five buddies', async () => {
    const a = await newDevice();
    for (let i = 0; i < 5; i += 1) {
      const other = await newDevice();
      const { code } = await json<{ code: string }>(await call('/invite', { method: 'POST', as: a }));
      expect((await call('/pair', { method: 'POST', as: other, body: JSON.stringify({ code }) })).status).toBe(201);
    }

    // The sixth cannot even be invited.
    expect((await call('/invite', { method: 'POST', as: a })).status).toBe(409);

    // Nor from the other direction: someone else's code, redeemed by a full device.
    const sixth = await newDevice();
    const { code } = await json<{ code: string }>(await call('/invite', { method: 'POST', as: sixth }));
    expect((await call('/pair', { method: 'POST', as: a, body: JSON.stringify({ code }) })).status).toBe(409);
  });

  it('either side can end the link, and the flags in flight go with it', async () => {
    const { a, b, pairId } = await newPair();
    await call('/send', { method: 'POST', as: a, body: markBody(pairId) });
    expect(await countRows('inbox')).toBe(1);

    expect((await call(`/pair/${pairId}`, { method: 'DELETE', as: b })).status).toBe(204);
    expect(await countRows('pairs')).toBe(0);
    expect(await countRows('inbox')).toBe(0);
  });
});

describe('one device cannot touch another device', () => {
  it('cannot read another device inbox', async () => {
    const { a, b, pairId } = await newPair();
    const stranger = await newDevice();

    await call('/send', { method: 'POST', as: a, body: markBody(pairId) });

    const mine = await json<{ marks: unknown[] }>(await call('/inbox', { as: b }));
    expect(mine.marks).toHaveLength(1);

    const theirs = await json<{ marks: unknown[] }>(await call('/inbox', { as: stranger }));
    expect(theirs.marks).toHaveLength(0);
  });

  it('cannot acknowledge — and so destroy — another device flags', async () => {
    const { a, b, pairId } = await newPair();
    const stranger = await newDevice();

    await call('/send', { method: 'POST', as: a, body: markBody(pairId) });
    const { marks } = await json<{ marks: { id: string }[] }>(await call('/inbox', { as: b }));
    const ids = marks.map((mark) => mark.id);

    const stolen = await call('/inbox/ack', { method: 'POST', as: stranger, body: JSON.stringify({ ids }) });
    expect((await json<{ removed: number }>(stolen)).removed).toBe(0);
    expect(await countRows('inbox')).toBe(1);

    const own = await call('/inbox/ack', { method: 'POST', as: b, body: JSON.stringify({ ids }) });
    expect((await json<{ removed: number }>(own)).removed).toBe(1);
    expect(await countRows('inbox')).toBe(0);
  });

  it('cannot unpair a link it is not part of, and is told nothing about it', async () => {
    const { pairId } = await newPair();
    const stranger = await newDevice();

    const response = await call(`/pair/${pairId}`, { method: 'DELETE', as: stranger });
    expect(response.status).toBe(404);
    expect(await countRows('pairs')).toBe(1);
  });

  it('cannot send into a link it is not part of', async () => {
    const { pairId } = await newPair();
    const stranger = await newDevice();

    const response = await call('/send', { method: 'POST', as: stranger, body: markBody(pairId) });
    expect(response.status).toBe(404);
    expect(await countRows('inbox')).toBe(0);
  });

  it('answers a pair id that does not exist the same way as one that is not yours', async () => {
    const stranger = await newDevice();
    const nowhere = 'a'.repeat(32);

    expect((await call(`/pair/${nowhere}`, { method: 'DELETE', as: stranger })).status).toBe(404);
    expect((await call('/send', { method: 'POST', as: stranger, body: markBody(nowhere) })).status).toBe(404);
  });
});

describe('flags', () => {
  it('carries a mark from one phone to the other, and forgets it once collected', async () => {
    const { a, b, pairId } = await newPair();

    expect((await call('/send', { method: 'POST', as: a, body: markBody(pairId) })).status).toBe(202);

    const { marks } = await json<{ marks: { id: string; prayer: string; state: string; pairId: string }[] }>(
      await call('/inbox', { as: b }),
    );
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ prayer: 'maghrib', state: 'prayed', pairId });

    await call('/inbox/ack', { method: 'POST', as: b, body: JSON.stringify({ ids: [marks[0]!.id] }) });
    expect(await countRows('inbox')).toBe(0);

    // Collected means gone: a second fetch is empty, and there is nothing left to re-read.
    const again = await json<{ marks: unknown[] }>(await call('/inbox', { as: b }));
    expect(again.marks).toHaveLength(0);
  });

  it('a replayed send lands on the row that is already there', async () => {
    const { a, b, pairId } = await newPair();
    const body = markBody(pairId);

    for (let i = 0; i < 5; i += 1) {
      await call('/send', { method: 'POST', as: a, body });
    }

    expect(await countRows('inbox')).toBe(1);
    const { marks } = await json<{ marks: unknown[] }>(await call('/inbox', { as: b }));
    expect(marks).toHaveLength(1);
  });

  it('a retraction replaces the mark rather than adding to it', async () => {
    const { a, b, pairId } = await newPair();

    await call('/send', { method: 'POST', as: a, body: markBody(pairId) });
    await call('/send', { method: 'POST', as: a, body: markBody(pairId, { state: 'cleared' }) });

    const { marks } = await json<{ marks: { state: string }[] }>(await call('/inbox', { as: b }));
    expect(marks).toHaveLength(1);
    expect(marks[0]!.state).toBe('cleared');
  });

  it('keeps one row per prayer', async () => {
    const { a, b, pairId } = await newPair();

    for (const prayer of ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']) {
      await call('/send', { method: 'POST', as: a, body: markBody(pairId, { prayer }) });
    }

    const { marks } = await json<{ marks: unknown[] }>(await call('/inbox', { as: b }));
    expect(marks).toHaveLength(5);
  });
});

describe('what a caller may say', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['a prayer that is not one of the five', { prayer: 'tahajjud' }],
    ['a state the feature does not have', { state: 'missed' }],
    ['another state the feature does not have', { state: 'exempt' }],
    ['a day in the wrong shape', { day: '15-09-2026' }],
    ['a day far from now', { day: '2030-01-01' }],
    ['a language that is not one', { lang: 'not-a-language-at-all' }],
    ['a notify flag that is not a boolean', { notify: 'yes' }],
    ['a title without a body', { title: 'Your buddy prayed' }],
    ['a title that is too long', { title: 'x'.repeat(41), body: 'ok' }],
    ['a body that is too long', { title: 'ok', body: 'x'.repeat(121) }],
    ['a link in the body', { title: 'ok', body: 'see https://example.com now' }],
    ['a bare domain in the body', { title: 'ok', body: 'go to example.com' }],
  ];

  it.each(bad)('refuses %s', async (_label, overrides) => {
    const { a, pairId } = await newPair();
    const response = await call('/send', { method: 'POST', as: a, body: markBody(pairId, overrides) });
    expect(response.status).toBe(400);
    expect(await countRows('inbox')).toBe(0);
  });

  it('refuses a body larger than the limit without parsing it', async () => {
    const { a, pairId } = await newPair();
    const response = await call('/send', {
      method: 'POST',
      as: a,
      body: markBody(pairId, { title: 'ok', body: 'ok', padding: 'x'.repeat(4000) }),
    });
    expect(response.status).toBe(400);
  });

  it('refuses an acknowledgement that is not a list of ids', async () => {
    const device = await newDevice();
    for (const ids of [[], 'nope', [123], ['not-an-id'], Array(201).fill('a'.repeat(32))]) {
      const response = await call('/inbox/ack', { method: 'POST', as: device, body: JSON.stringify({ ids }) });
      expect(response.status).toBe(400);
    }
  });

  it('accepts a mark with no text at all — that is how a muted buddy is served', async () => {
    const { a, b, pairId } = await newPair();
    await setToken(b);

    const response = await call('/send', { method: 'POST', as: a, body: markBody(pairId) });
    expect(response.status).toBe(202);
  });
});

describe('rate limits', () => {
  it('stops a code being guessed at', async () => {
    const guesser = await newDevice();
    const ip = '203.0.113.7';

    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const response = await call('/pair', {
        method: 'POST',
        as: guesser,
        ip,
        body: JSON.stringify({ code: 'ABCD2345' }),
      });
      statuses.push(response.status);
    }

    // The first few are answered as wrong codes; the rest are not answered at all.
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
  });

  it('caps how many marks one link can carry in a day', async () => {
    const { a, pairId } = await newPair();

    let limited = false;
    for (let i = 0; i < 45; i += 1) {
      const response = await call('/send', {
        method: 'POST',
        as: a,
        // A different prayer each time, so the cap is what stops this and not the unique key.
        body: markBody(pairId, { prayer: ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'][i % 5] }),
      });
      if (response.status === 429) limited = true;
    }

    expect(limited).toBe(true);
  });
});

describe('the sweep', () => {
  it('deletes flags that were never collected, and invites nobody used', async () => {
    const { a, pairId } = await newPair();
    await call('/send', { method: 'POST', as: a, body: markBody(pairId) });
    await call('/invite', { method: 'POST', as: a });

    expect(await countRows('inbox')).toBe(1);
    expect(await countRows('invites')).toBe(1);

    // A day and a minute later.
    await sweep(env.DB, Date.now() + 24 * 60 * 60 * 1000 + 60_000);

    expect(await countRows('inbox')).toBe(0);
    expect(await countRows('invites')).toBe(0);
  });

  it('retires devices and pairs that have gone quiet for ninety days', async () => {
    await newPair();
    expect(await countRows('pairs')).toBe(1);

    await sweep(env.DB, Date.now() + 91 * 24 * 60 * 60 * 1000);

    expect(await countRows('pairs')).toBe(0);
    expect(await countRows('devices')).toBe(0);
  });

  it('leaves a link alone while it is still in use', async () => {
    const { a, pairId } = await newPair();
    await call('/send', { method: 'POST', as: a, body: markBody(pairId) });

    await sweep(env.DB, Date.now() + 60 * 1000);

    expect(await countRows('pairs')).toBe(1);
    expect(await countRows('devices')).toBe(2);
    expect(await countRows('inbox')).toBe(1);
  });
});

describe('what the database can be made to hold', () => {
  it('holds nothing but random ids, a prayer, a day and timestamps', async () => {
    const { a, b, pairId } = await newPair();
    await setToken(a);
    await call('/send', {
      method: 'POST',
      as: a,
      body: markBody(pairId, { title: 'Your buddy prayed', body: 'Maghrib' }),
    });

    // The title and body the sender wrote are handed to the push service and never written down.
    const inbox = await env.DB.prepare('SELECT * FROM inbox').all();
    const asText = JSON.stringify(inbox.results);
    expect(asText).not.toContain('Your buddy prayed');
    expect(asText).not.toContain('en');

    // And nothing anywhere carries the day's text beyond the day itself.
    const columns = await env.DB.prepare('SELECT * FROM inbox LIMIT 1').first<Record<string, unknown>>();
    expect(Object.keys(columns ?? {}).sort()).toEqual(
      ['day', 'expires_at', 'id', 'pair_id', 'prayer', 'state', 'to_device'].sort(),
    );
    expect(columns?.day).toBe(today());
    void b;
  });
});
