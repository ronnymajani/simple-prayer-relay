import type { D1Migration } from '@cloudflare/vitest-plugin';
import type { Env as WorkerEnv } from '../src/routes';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends WorkerEnv {
    MIGRATIONS: D1Migration[];
  }
}
