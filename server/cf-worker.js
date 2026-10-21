/**
 * Cloudflare Workers entry — hardened for nodejs_compat
 *
 * - Lazy-requires db/app so a boot error never becomes a bare 1101
 * - /api/health always returns JSON (success or diagnostic error)
 * - HYPE_DB KV for persistence
 * - ASSETS binding for static files
 * - iconv-lite streams workaround (process.versions.node)
 */
let app = null;
let booted = false;
let bootPromise = null;
let bootError = null;
let nodeHandler = null;

async function ensureBoot(env) {
  if (booted) return;
  if (bootPromise) return bootPromise;

  bootPromise = (async () => {
    try {
      // Mark CF early so db.js skips __dirname / FS paths
      process.env.CLOUDFLARE = '1';
      process.env.NODE_ENV = process.env.NODE_ENV || 'production';

      // Inject string secrets/vars into process.env
      if (env) {
        for (const key of Object.keys(env)) {
          if (typeof env[key] === 'string' && !process.env[key]) {
            process.env[key] = env[key];
          }
        }
      }

      // --- iconv-lite fix: must run BEFORE requiring express/app ---
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

        // Lazy require — never at module top-level
        const db = require('./db');
        const { createApp } = require('./app');

        if (env && env.HYPE_DB) {
          db.setKvBinding(env.HYPE_DB);
          await db.loadFromKv();
        }

        db.migrate();
        db.seed();
        app = createApp();
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

      booted = true;
      bootError = null;
      console.log('[cf-worker] app booted OK');
    } catch (e) {
      bootError = {
        message: e && e.message ? e.message : String(e),
        stack: e && e.stack ? String(e.stack).slice(0, 1500) : null,
        name: e && e.name ? e.name : 'Error'
      };
      console.error('[cf-worker] BOOT FAILED:', bootError.message, bootError.stack);
      // Do not rethrow — fetch handler will return diagnostic JSON
    }
  })();

  return bootPromise;
}

function getHttpServerHandler() {
  if (nodeHandler) return nodeHandler;
  if (!app) return null;
  try {
    const { httpServerHandler } = require('cloudflare:node');
    nodeHandler = httpServerHandler(app);
    return nodeHandler;
  } catch (e) {
    console.warn('[cf-worker] httpServerHandler unavailable:', e && e.message);
    return null;
  }
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

function healthResponse(extra) {
  return Response.json({
    ok: !bootError,
    time: new Date().toISOString(),
    runtime: 'cloudflare',
    booted: booted,
    ...(bootError
      ? { error: bootError.message, errorName: bootError.name, stack: bootError.stack }
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

    // Always answer health — even if boot failed (shows real error, not 1101)
    if (path === '/api/health') {
      if (bootError) return healthResponse();
      const handler = getHttpServerHandler();
      if (handler) {
        try {
          return await handler.fetch(request, env, ctx);
        } catch (e) {
          return healthResponse({ expressError: e && e.message ? e.message : String(e) });
        }
      }
      return healthResponse({ note: 'express handler not ready' });
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
      const handler = getHttpServerHandler();
      if (handler) {
        try {
          return await handler.fetch(request, env, ctx);
        } catch (e) {
          return Response.json({
            ok: false,
            error: e && e.message ? e.message : String(e),
            runtime: 'cloudflare',
            phase: 'express'
          }, { status: 500 });
        }
      }
      return new Response(
        'Hyperliquid Miner — httpServerHandler unavailable. Check compatibility_flags = ["nodejs_compat"] and compatibility_date >= 2025-09-15',
        { status: 503 }
      );
    }

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
      const job = require('./jobs/miningPauseNotify');
      if (typeof job.runMiningPauseNotify === 'function') {
        await job.runMiningPauseNotify();
      }
    } catch (e) {
      console.warn('scheduled mining pause failed', e && e.message);
    }
  }
};
