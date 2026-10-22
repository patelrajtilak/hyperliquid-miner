/**
 * Cloudflare Workers entry — Express via node:http createServer + handleAsNodeRequest
 *
 * cloudflare:node MUST be loaded via ESM import (require() fails in Workers runtime).
 * Custom fetch: /api → Express, everything else → ASSETS binding.
 */
import { handleAsNodeRequest, httpServerHandler } from 'cloudflare:node';

let app = null;
let server = null;
let booted = false;
let bootPromise = null;
let bootError = null;
let handlerError = null;
let nodeHandler = null;

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

async function ensureBoot(env) {
  if (booted) return;
  if (bootPromise) return bootPromise;

  bootPromise = (async () => {
    try {
      process.env.CLOUDFLARE = '1';
      try { if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production'; } catch (_) {}

      // Cloudflare Secrets / Vars → process.env (Workers do NOT load .env files)
      if (env) {
        for (const key of Object.keys(env)) {
          const val = env[key];
          if (typeof val === 'string' && val.length > 0) {
            process.env[key] = val;
          }
        }
        const critical = [
          'BOT_TOKEN', 'JWT_SECRET', 'ADMIN_PASSWORD', 'ADMIN_USERNAME',
          'WEBAPP_URL', 'REFERRAL_SALT', 'ADMIN_TELEGRAM_IDS',
          'COMMUNITY_CHANNEL_URL', 'ADMIN_PANEL_PATH'
        ];
        for (const key of critical) {
          if (typeof env[key] === 'string' && env[key].length > 0) {
            process.env[key] = env[key];
          }
        }
      }
      if (!process.env.BOT_TOKEN) {
        console.warn('[cf-worker] BOT_TOKEN missing — set via: npx wrangler secret put BOT_TOKEN');
      }

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
            try { process.versions.node = undefined; } catch (_) {}
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

        // Wire Express into a real node:http.Server (required by CF adapter)
        const { createServer } = require('node:http');
        server = createServer(app);
        // Port is virtual on Workers — used only as a registry key
        try {
          server.listen(3000);
        } catch (listenErr) {
          console.warn('[cf-worker] server.listen:', listenErr && listenErr.message);
        }
      } finally {
        if (process.versions && savedNodeVer !== undefined) {
          try {
            Object.defineProperty(process.versions, 'node', {
              value: savedNodeVer,
              configurable: true,
              writable: true
            });
          } catch (_) {
            try { process.versions.node = savedNodeVer; } catch (_) {}
          }
        }
      }

      // handleAsNodeRequest already imported at top (ESM).
      // Also wire httpServerHandler as fallback.
      try {
        if (typeof httpServerHandler === 'function' && server) {
          try {
            nodeHandler = httpServerHandler(server);
          } catch (_) {
            nodeHandler = httpServerHandler({ port: 3000 });
          }
        }
      } catch (e) {
        handlerError = e && e.message ? e.message : String(e);
        console.warn('[cf-worker] httpServerHandler setup failed:', handlerError);
      }

      booted = true;
      bootError = null;
      console.log(
        '[cf-worker] app booted OK, handleAsNodeRequest=',
        typeof handleAsNodeRequest === 'function',
        'httpServerHandler=',
        !!nodeHandler
      );
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

async function dispatchToExpress(request, env, ctx) {
  // Primary: ESM-imported handleAsNodeRequest
  if (typeof handleAsNodeRequest === 'function' && server) {
    return handleAsNodeRequest(server, request);
  }
  // Fallback: httpServerHandler instance
  if (nodeHandler && typeof nodeHandler.fetch === 'function') {
    return nodeHandler.fetch(request, env, ctx);
  }
  return null;
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

function healthJson(extra) {
  const hasBot = !!(process.env.BOT_TOKEN && String(process.env.BOT_TOKEN).length > 10);
  const hasJwt = !!(process.env.JWT_SECRET && String(process.env.JWT_SECRET).length > 8);
  return Response.json({
    ok: !bootError,
    time: new Date().toISOString(),
    runtime: 'cloudflare',
    booted,
    hasServer: !!server,
    hasHandleAsNodeRequest: typeof handleAsNodeRequest === 'function',
    hasHttpServerHandler: !!nodeHandler,
    secrets: {
      BOT_TOKEN: hasBot,
      JWT_SECRET: hasJwt,
      WEBAPP_URL: !!(process.env.WEBAPP_URL),
      ADMIN_PASSWORD: !!(process.env.ADMIN_PASSWORD)
    },
    ...(handlerError ? { handlerError } : {}),
    ...(bootError
      ? { error: bootError.message, errorName: bootError.name, stack: bootError.stack }
      : {}),
    ...(!hasBot
      ? {
          tip: 'Set BOT_TOKEN: Cloudflare Dashboard → Worker → Settings → Variables → Secrets, OR: npx wrangler secret put BOT_TOKEN'
        }
      : {}),
    ...(extra || {})
  }, { status: bootError ? 500 : 200 });
}

export default {
  async fetch(request, env, ctx) {
    try {
      await ensureBoot(env);
    } catch (e) {
      return Response.json({
        ok: false,
        error: e && e.message ? e.message : String(e),
        runtime: 'cloudflare',
        phase: 'ensureBoot'
      }, { status: 500 });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Health: try Express first; always return useful diagnostics
    if (path === '/api/health' || path === '/__health') {
      if (bootError) return healthJson();
      try {
        const res = await dispatchToExpress(request, env, ctx);
        if (res) return res;
      } catch (e) {
        return healthJson({ expressError: e && e.message ? e.message : String(e) });
      }
      return healthJson({ note: 'express handler not ready' });
    }

    if (bootError && path.startsWith('/api')) {
      return Response.json({
        ok: false,
        error: bootError.message,
        errorName: bootError.name,
        stack: bootError.stack,
        runtime: 'cloudflare'
      }, { status: 500 });
    }

    const isApi =
      path.startsWith('/api') ||
      path === '/tonconnect-manifest.json';

    if (isApi) {
      try {
        const res = await dispatchToExpress(request, env, ctx);
        if (res) return res;
      } catch (e) {
        return Response.json({
          ok: false,
          error: e && e.message ? e.message : String(e),
          runtime: 'cloudflare',
          phase: 'express'
        }, { status: 500 });
      }
      return Response.json({
        ok: false,
        error: 'Express handler unavailable',
        handlerError: handlerError || null,
        hasServer: !!server,
        hasHandleAsNodeRequest: typeof handleAsNodeRequest === 'function',
        hasHttpServerHandler: !!nodeHandler,
        hint: 'Need compatibility_flags=["nodejs_compat"] and compatibility_date >= 2025-09-15'
      }, { status: 503 });
    }

    // Static assets via ASSETS binding
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
    } catch (e) {
      console.warn('scheduled mining pause failed', e && e.message);
    }
  }
};
