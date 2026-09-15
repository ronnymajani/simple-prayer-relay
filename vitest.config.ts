import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// The tests run against the real schema, read from the same migrations directory that is deployed.
// A test that passes against a hand-written copy of the schema proves nothing about production.
const migrations = await readD1Migrations('migrations');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          MIGRATIONS: migrations,
          // Test-only values. Production secrets never appear in this repo.
          TOKEN_KEY: 'dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXktMzJieXQ=',
          IP_SECRET: 'test-ip-secret',
          // Empty on purpose: with no Expo token the relay never tries to reach the push service,
          // so the tests exercise the database without touching the network.
          EXPO_ACCESS_TOKEN: '',
        },
      },
    }),
  ],
  test: {
    globals: true,
    setupFiles: ['./test/setup.ts'],
  },
});
