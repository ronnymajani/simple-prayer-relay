import type { D1Migration } from '@cloudflare/vitest-plugin';
import type { Env as WorkerEnv } from '../src/routes';

/**
 * `cloudflare:test` types its `env` as `Cloudflare.Env`, so the bindings are declared by augmenting
 * that rather than the `ProvidedEnv` interface older versions of the pool used.
 *
 * `MIGRATIONS` is not a real binding — vitest.config.ts passes the parsed migration list in as one
 * so that `test/setup.ts` can apply the real schema before each file.
 */
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      MIGRATIONS: D1Migration[];
    }
  }
}

export {};
