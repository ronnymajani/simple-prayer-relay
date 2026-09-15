// The Simple Prayer buddy relay.
//
// It forwards one flag — "prayed Maghrib today" — from one phone to another phone that agreed to
// receive it, and forgets it as soon as that phone has collected it. It has no accounts, no
// profiles, no history, no logs and no idea who anybody is. See README.md for the whole story and
// migrations/0001_init.sql for the whole database.

import * as Sentry from '@sentry/cloudflare';
import { route, type Env } from './routes';
import { sweep } from './db';
import { sentryOptions } from './sentry';

const handler: ExportedHandler<Env> = {
  async fetch(request, env): Promise<Response> {
    // Cloudflare terminates TLS before us, so this only ever fires if the Worker is reached some
    // other way. The relay refuses to speak plaintext rather than trust that it cannot happen.
    if (new URL(request.url).protocol !== 'https:') {
      return new Response(null, { status: 403 });
    }

    try {
      return await route(request, env, Date.now());
    } catch (error) {
      // Sentry gets the error (scrubbed — see sentry.ts). The caller gets a bare 500: which
      // statement failed is our problem, not information to hand out.
      Sentry.captureException(error);
      return new Response(null, { status: 500 });
    }
  },

  async scheduled(_event, env, ctx): Promise<void> {
    // A check-in each hour is how the owner learns the sweep has stopped running — which would mean
    // rows outliving their expiry, the one failure here that matters to anybody's privacy.
    const checkInId = env.SENTRY_DSN
      ? Sentry.captureCheckIn({ monitorSlug: 'relay-sweep', status: 'in_progress' })
      : undefined;

    ctx.waitUntil(
      (async () => {
        try {
          await sweep(env.DB, Date.now());
          if (checkInId) {
            Sentry.captureCheckIn({ checkInId, monitorSlug: 'relay-sweep', status: 'ok' });
          }
        } catch (error) {
          if (checkInId) {
            Sentry.captureCheckIn({ checkInId, monitorSlug: 'relay-sweep', status: 'error' });
          }
          Sentry.captureException(error);
        }
      })(),
    );
  },
};

export default Sentry.withSentry(sentryOptions, handler);
