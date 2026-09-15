import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach } from 'vitest';

// Every test file starts against the real schema — the one in migrations/, not a hand-written copy,
// because a test that passes against a copy proves nothing about production.
await applyD1Migrations(env.DB, env.MIGRATIONS);

// And every test starts against an empty one. Several tests assert on whole-table counts ("the
// relay now holds nothing"), which is the clearest way to state what this service must not keep,
// and it only means anything if the previous test left nothing behind.
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM inbox'),
    env.DB.prepare('DELETE FROM pairs'),
    env.DB.prepare('DELETE FROM invites'),
    env.DB.prepare('DELETE FROM quota'),
    env.DB.prepare('DELETE FROM devices'),
  ]);
});
