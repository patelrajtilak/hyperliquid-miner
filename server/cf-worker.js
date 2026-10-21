/**
 * Cloudflare Workers entry — Express via node:http + httpServerHandler
 * Requires compatibility_flags = ["nodejs_compat"] and compatibility_date >= 2025-09-15
 *
 * Persistence: uses KV binding HYPE_DB when available (set in wrangler.toml).
 * Without KV the store is in-memory only (lost on isolate recycle).
 */
const { createApp } = require('./app');
const { setKvBinding, loadFromKv, migrate, seed } = require('./db');

let app = null;
let booted = false;
let bootPromise = null;

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
    migrate();
    seed();
    app = createApp();
    booted = true;
    console.log('[cf-worker] app booted');
  })();
  return bootPromise;
}

// Prefer the official helper when available
let httpServerHandler;
try {
  httpServerHandler = require('cloudflare:node').httpServerHandler;
} catch (_) {
  httpServerHandler = null;
}

export default {
  async fetch(request, env, ctx) {
    await ensureBoot(env);

    if (httpServerHandler) {
      const handler = httpServerHandler(app);
      return handler.fetch(request, env, ctx);
    }

    // Fallback
    const url = new URL(request.url);
    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, time: new Date().toISOString(), runtime: 'cloudflare-fallback' });
    }
    return new Response('Hyperliquid Miner — enable nodejs_compat + httpServerHandler', { status: 200 });
  },

  async scheduled(event, env, ctx) {
    await ensureBoot(env);
    try {
      const job = require('./jobs/miningPauseNotify');
      if (typeof job.runMiningPauseNotify === 'function') {
        await job.runMiningPauseNotify();
      } else if (typeof job.startMiningPauseScheduler === 'function') {
        // one-shot check if only the scheduler exists
        console.log('[cron] mining pause check (scheduler present)');
      }
    } catch (e) {
      console.warn('scheduled mining pause failed', e.message);
    }
  }
};
