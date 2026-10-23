/**
 * Cloudflare Workers entry
 * Official pattern: createServer(app).listen(PORT) + httpServerHandler({ port: PORT })
 * Custom fetch: /api → Express, rest → ASSETS
 */
import { httpServerHandler } from 'cloudflare:node';

const PORT = 3000;

let app = null;
let server = null;
let booted = false;
let bootPromise = null;
let bootError = null;
let expressHandler = null;

function unwrapCjs(mod) {
  if (!mod) return mod;
  if (typeof mod.setKvBinding === 'function') return mod;
  if (typeof mod.createApp === 'function') return mod;
  if (mod.default && typeof mod.default === 'object') {
    if (typeof mod.default.setKvBinding === 'function') return mod.default;
    if (typeof mod.default.createApp === 'function') return mod.default;
    return mod.default;
  }
  return mod;
}

const CRITICAL_ENV = [
  'BOT_TOKEN', 'JWT_SECRET', 'ADMIN_PASSWORD', 'ADMIN_USERNAME',
  'WEBAPP_URL', 'REFERRAL_SALT', 'ADMIN_TELEGRAM_IDS',
  'COMMUNITY_CHANNEL_URL', 'ADMIN_PANEL_PATH', 'BOT_USERNAME',
  'ALLOW_DEV_LOGIN', 'NODE_ENV'
];

/** Copy CF env/secrets → process.env on EVERY request (warm isolates after secret add). */
function syncEnv(env) {
  if (!env) return { hasBot: false, keys: [] };
  process.env.CLOUDFLARE = '1';
  const found = [];
  try {
    for (const key of Object.keys(env)) {
      const val = env[key];
      if (typeof val === 'string' && val.length > 0) {
        process.env[key] = val;
        found.push(key);
      }
    }
  } catch (_) {}
  for (const key of CRITICAL_ENV) {
    try {
      const val = env[key];
      if (typeof val === 'string' && val.length > 0) {
        process.env[key] = val;
        if (!found.includes(key)) found.push(key);
      }
    } catch (_) {}
  }
  const hasBot = !!(process.env.BOT_TOKEN && String(process.env.BOT_TOKEN).length > 10);
  if (!hasBot) {
    console.warn('[cf-worker] BOT_TOKEN still missing after syncEnv. env keys:', found.join(','));
  }
  return { hasBot, keys: found };
}

async function ensureBoot(env) {
  // Always re-sync secrets (even if already booted)
  syncEnv(env);

  if (booted && expressHandler) return;
  if (bootPromise) return bootPromise;

  bootPromise = (async () => {
    try {
      process.env.CLOUDFLARE = '1';
      syncEnv(env);
      if (!process.env.BOT_TOKEN) {
        console.warn('[cf-worker] BOT_TOKEN missing at boot');
      }

      // Avoid express "Failed to determine port" / version quirks on Workers
      const savedNodeVer =
        process.versions && typeof process.versions.node === 'string'
          ? process.versions.node
          : undefined;
      try {
        if (process.versions) {
          try {
            Object.defineProperty(process.versions, 'node', {
              value: undefined,
              configurable: true,
              writable: true
            });
          } catch (_) {
            try {
              process.versions.node = undefined;
            } catch (_) {}
          }
        }

        const db = unwrapCjs(require('./db'));
        const appMod = unwrapCjs(require('./app'));
        const createApp = appMod.createApp || (appMod.default && appMod.default.createApp);

        if (typeof db.setKvBinding !== 'function') {
          throw new Error('db.setKvBinding missing. Keys: ' + Object.keys(db || {}).join(','));
        }
        if (typeof createApp !== 'function') {
          throw new Error('createApp missing. Keys: ' + Object.keys(appMod || {}).join(','));
        }

        if (env && env.HYPE_DB) {
          db.setKvBinding(env.HYPE_DB);
          if (typeof db.loadFromKv === 'function') await db.loadFromKv();
        }

        if (typeof db.migrate === 'function') db.migrate();
        if (typeof db.seed === 'function') db.seed();
        app = createApp();

        const { createServer } = require('node:http');
        server = createServer(app);
        await new Promise((resolve, reject) => {
          try {
            server.listen(PORT, () => resolve());
          } catch (e) {
            // already listening
            resolve();
          }
          // listen may not call callback on CF — resolve on next tick
          setTimeout(resolve, 0);
        });
      } finally {
        if (process.versions && savedNodeVer !== undefined) {
          try {
            Object.defineProperty(process.versions, 'node', {
              value: savedNodeVer,
              configurable: true,
              writable: true
            });
          } catch (_) {
            try {
              process.versions.node = savedNodeVer;
            } catch (_) {}
          }
        }
      }

      // Official CF adapter — MUST use { port } after server.listen(port)
      expressHandler = httpServerHandler({ port: PORT });

      booted = true;
      bootError = null;
      console.log('[cf-worker] booted OK, port=', PORT);
    } catch (e) {
      bootError = {
        message: e && e.message ? e.message : String(e),
        stack: e && e.stack ? String(e.stack).slice(0, 1500) : null,
        name: e && e.name ? e.name : 'Error'
      };
      console.error('[cf-worker] BOOT FAILED:', bootError.message);
    }
  })();

  return bootPromise;
}

function rewriteAdminPath(url) {
  const adminPath = (process.env.ADMIN_PANEL_PATH || '/hq-control').replace(/\/$/, '');
  const pathname = url.pathname.replace(/\/$/, '') || '/';
  if (pathname === adminPath || pathname === '/admin') {
    url.pathname = '/admin.html';
    return true;
  }
  return false;
}

function healthJson(extra, env) {
  const sync = syncEnv(env);
  const hasBot = !!(process.env.BOT_TOKEN && String(process.env.BOT_TOKEN).length > 10);
  const hasJwt = !!(process.env.JWT_SECRET && String(process.env.JWT_SECRET).length > 8);
  const envHasBot = !!(env && typeof env.BOT_TOKEN === 'string' && env.BOT_TOKEN.length > 10);
  return Response.json(
    {
      ok: !bootError && hasBot,
      time: new Date().toISOString(),
      runtime: 'cloudflare',
      booted,
      hasServer: !!server,
      hasExpressHandler: !!expressHandler,
      secrets: {
        BOT_TOKEN: hasBot,
        JWT_SECRET: hasJwt,
        WEBAPP_URL: !!process.env.WEBAPP_URL,
        ADMIN_PASSWORD: !!process.env.ADMIN_PASSWORD
      },
      debug: {
        envBindingHasBOT_TOKEN: envHasBot,
        processEnvHasBOT_TOKEN: hasBot,
        envKeySample: (sync.keys || []).filter(k =>
          /TOKEN|SECRET|ADMIN|WEBAPP|BOT|JWT|REFERRAL/i.test(k)
        )
      },
      ...(bootError
        ? { error: bootError.message, errorName: bootError.name, stack: bootError.stack }
        : {}),
      ...(!hasBot
        ? {
            tip: 'Secret name must be exactly BOT_TOKEN. Dashboard → Workers & Pages → hyperliquid-miner → Settings → Variables and Secrets. After adding, click Deploy. Then open /api/health again.'
          }
        : {}),
      ...(extra || {})
    },
    { status: bootError ? 500 : 200 }
  );
}

export default {
  async fetch(request, env, ctx) {
    try {
      await ensureBoot(env);
    } catch (e) {
      return Response.json(
        {
          ok: false,
          error: e && e.message ? e.message : String(e),
          runtime: 'cloudflare',
          phase: 'ensureBoot'
        },
        { status: 500 }
      );
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/health' || path === '/__health') {
      if (bootError) return healthJson(undefined, env);
      if (!expressHandler) return healthJson({ note: 'express handler not ready' }, env);
      try {
        const res = await expressHandler.fetch(request, env, ctx);
        if (res) return res;
      } catch (e) {
        return healthJson({ expressError: e && e.message ? e.message : String(e)
         }, env);
      }
      return healthJson(undefined, env);
    }

    if (bootError && path.startsWith('/api')) {
      return Response.json(
        {
          ok: false,
          error: bootError.message,
          errorName: bootError.name,
          stack: bootError.stack,
          runtime: 'cloudflare'
        },
        { status: 500 }
      );
    }

    const isApi = path.startsWith('/api') || path === '/tonconnect-manifest.json';

    if (isApi) {
      if (!expressHandler) {
        return Response.json(
          {
            ok: false,
            error: 'Express handler unavailable',
            hasServer: !!server,
            hasExpressHandler: false,
            hint: 'compatibility_flags=["nodejs_compat"], compatibility_date >= 2025-09-15'
          },
          { status: 503 }
        );
      }
      try {
        const res = await expressHandler.fetch(request, env, ctx);
        // CRITICAL: keep isolate alive until KV puts finish — otherwise Storage stays 0 B
        try {
          const db = unwrapCjs(require('./db'));
          if (db && typeof db.flushPending === 'function' && ctx && typeof ctx.waitUntil === 'function') {
            ctx.waitUntil(db.flushPending());
          }
        } catch (_) {}
        return res;
      } catch (e) {
        try {
          const db = unwrapCjs(require('./db'));
          if (db && typeof db.flushPending === 'function' && ctx && typeof ctx.waitUntil === 'function') {
            ctx.waitUntil(db.flushPending());
          }
        } catch (_) {}
        return Response.json(
          {
            ok: false,
            error: e && e.message ? e.message : String(e),
            runtime: 'cloudflare',
            phase: 'express'
          },
          { status: 500 }
        );
      }
    }

    // Static assets
    if (env && env.ASSETS) {
      try {
        const rewritten = new URL(request.url);
        rewriteAdminPath(rewritten);
        const assetReq =
          rewritten.pathname !== url.pathname
            ? new Request(rewritten.toString(), request)
            : request;
        return env.ASSETS.fetch(assetReq);
      } catch (e) {
        return new Response('Assets error: ' + (e && e.message ? e.message : String(e)), {
          status: 500
        });
      }
    }

    return new Response(
      'Static assets not configured. Add [assets] directory = "./public" binding = "ASSETS" in wrangler.toml',
      { status: 500 }
    );
  },

  async scheduled(event, env, ctx) {
    try {
      await ensureBoot(env);
      if (bootError) {
        console.warn('[cron] skipped — boot failed:', bootError.message);
        return;
      }
      const jobMod = require('./jobs/miningPauseNotify');
      const job =
        jobMod && typeof jobMod.runMiningPauseNotify === 'function'
          ? jobMod
          : jobMod && jobMod.default
            ? jobMod.default
            : jobMod;
      if (typeof job.runMiningPauseNotify === 'function') {
        await job.runMiningPauseNotify();
      }
      try {
        const db = unwrapCjs(require('./db'));
        if (db && typeof db.flushPending === 'function') await db.flushPending();
      } catch (_) {}
    } catch (e) {
      console.warn('scheduled mining pause failed', e && e.message);
    }
  }
};
