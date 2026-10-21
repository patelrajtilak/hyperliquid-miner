/**
 * Cloudflare Workers entry — Express via node:http + httpServerHandler
 * Requires compatibility_flags = ["nodejs_compat"] and compatibility_date >= 2025-09-15
 *
 * Persistence: uses KV binding HYPE_DB when available (set in wrangler.toml).
 * Without KV the store is in-memory only (lost on isolate recycle).
 *
 * Static assets: served by the [assets] binding (public/). Express never
 * touches the filesystem on CF.
 *
 * iconv-lite workaround:
 *   body-parser (transitive via express) loads iconv-lite, which does
 *   require_streams()(iconv) when process.versions.node is set.
 *   Wrangler's browser-field rewrite turns that into a non-function.
 *   We temporarily clear process.versions.node before the first require
 *   of express/app so the streams extension is skipped. JSON bodies are
 *   handled by the custom parser in app.js (no body-parser needed).
 */
const { setKvBinding, loadFromKv, migrate, seed } = require('./db');

let app = null;
let booted = false;
let bootPromise = null;
let nodeHandler = null;

async function ensureBoot(env) {
  if (booted) return;
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    // Inject KV into db layer if present
    if (env && env.HYPE_DB) {
      setKvBinding(env.HYPE_DB);
      await loadFromKv();
    }
    // Make secrets / vars available as process.env
    if (env) {
      for (const key of Object.keys(env)) {
        if (typeof env[key] === 'string' && !process.env[key]) {
          process.env[key] = env[key];
        }
      }
    }
    process.env.CLOUDFLARE = '1';
    process.env.NODE_ENV = process.env.NODE_ENV || 'production';

    // --- iconv-lite / body-parser streams fix ---
    // Must run BEFORE any require() that pulls in express → body-parser → iconv-lite
    const savedNodeVer = process.versions && process.versions.node;
    try {
      if (process.versions) {
        // Make the iconv-lite "if (nodeVer)" branch false so it never calls require_streams()
        Object.defineProperty(process.versions, 'node', {
          value: undefined,
          configurable: true,
          writable: true
        });
      }
      // Now safe to load Express app factory
      const { createApp } = require('./app');
      migrate();
      seed();
      app = createApp();
    } finally {
      // Restore for any other code that expects a real node version string
      if (process.versions && savedNodeVer !== undefined) {
        try {
          Object.defineProperty(process.versions, 'node', {
            value: savedNodeVer,
            configurable: true,
            writable: true
          });
        } catch (_) {
          process.versions.node = savedNodeVer;
        }
      }
    }

    booted = true;
    console.log('[cf-worker] app booted');
  })();
  return bootPromise;
}

function getHttpServerHandler() {
  if (nodeHandler) return nodeHandler;
  try {
    const { httpServerHandler } = require('cloudflare:node');
    nodeHandler = httpServerHandler(app);
    return nodeHandler;
  } catch (e) {
    console.warn('[cf-worker] cloudflare:node httpServerHandler unavailable:', e.message);
    return null;
  }
}

/** Rewrite friendly admin paths to the real static file */
function rewriteAdminPath(url) {
  const adminPath = (process.env.ADMIN_PANEL_PATH || '/hq-control').replace(/\/$/, '');
  const pathname = url.pathname.replace(/\/$/, '') || '/';
  const adminPaths = new Set([adminPath, '/admin']);
  if (adminPaths.has(pathname)) {
    url.pathname = '/admin.html';
    return true;
  }
  return false;
}

export default {
  async fetch(request, env, ctx) {
    await ensureBoot(env);

    const url = new URL(request.url);
    const path = url.pathname;

    // API + dynamic routes → Express (via node:http adapter)
    const isApi =
      path.startsWith('/api') ||
      path === '/tonconnect-manifest.json';

    if (isApi) {
      const handler = getHttpServerHandler();
      if (handler) {
        return handler.fetch(request, env, ctx);
      }
      if (path === '/api/health') {
        return Response.json({
          ok: true,
          time: new Date().toISOString(),
          runtime: 'cloudflare-fallback'
        });
      }
      return new Response('Hyperliquid Miner — enable nodejs_compat + httpServerHandler', {
        status: 503
      });
    }

    // Everything else → static assets binding
    if (env.ASSETS) {
      const rewritten = new URL(request.url);
      rewriteAdminPath(rewritten);
      const assetReq =
        rewritten.pathname !== url.pathname
          ? new Request(rewritten.toString(), request)
          : request;
      return env.ASSETS.fetch(assetReq);
    }

    return new Response(
      'Static assets not configured. Add [assets] directory = "./public" in wrangler.toml',
      { status: 500 }
    );
  },

  async scheduled(event, env, ctx) {
    await ensureBoot(env);
    try {
      const job = require('./jobs/miningPauseNotify');
      if (typeof job.runMiningPauseNotify === 'function') {
        await job.runMiningPauseNotify();
      } else if (typeof job.startMiningPauseScheduler === 'function') {
        console.log('[cron] mining pause check (scheduler present)');
      }
    } catch (e) {
      console.warn('scheduled mining pause failed', e.message);
    }
  }
};
