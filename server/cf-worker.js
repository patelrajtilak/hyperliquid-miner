/**
 * HYPE MINER — Cloudflare Worker entry
 * Express + node:http + Cloudflare HTTP adapter
 */

import { createServer } from 'node:http';
import { httpServerHandler } from 'cloudflare:node';

let app = null;
let server = null;
let bootPromise = null;
let bootError = null;
let handlerError = null;
let nodeHandler = null;
let dbModule = null;

function unwrapModule(mod) {
  return mod?.default || mod;
}

async function ensureBoot(env) {
  if (nodeHandler) return;
  if (bootPromise) return bootPromise;

  bootPromise = (async () => {
    try {
      process.env.CLOUDFLARE = '1';

      // Expose string environment bindings to existing Node code.
      for (const key of [
        'BOT_TOKEN',
        'JWT_SECRET',
        'ADMIN_PASSWORD',
        'ADMIN_USERNAME',
        'WEBAPP_URL',
        'REFERRAL_SALT',
        'COMMUNITY_CHANNEL_URL',
        'ADMIN_PANEL_PATH'
      ]) {
        if (typeof env?.[key] === 'string') {
          process.env[key] = env[key];
        }
      }

      const db = unwrapModule(require('./db'));
      dbModule = db;

      const appModule = unwrapModule(require('./app'));
      const createApp = appModule.createApp;

      if (typeof createApp !== 'function') {
        throw new Error(
          'createApp export missing from server/app.js'
        );
      }

      // Bind Cloudflare KV only if this database module supports it.
      if (env?.HYPE_DB) {
        if (typeof db.setKvBinding === 'function') {
          await db.setKvBinding(env.HYPE_DB);
        } else if (typeof db.setKVBinding === 'function') {
          await db.setKVBinding(env.HYPE_DB);
        } else if (typeof db.setKv === 'function') {
          await db.setKv(env.HYPE_DB);
        } else {
          throw new Error(
            'KV binding function missing in server/db.js. Exports: ' +
            Object.keys(db || {}).join(', ')
          );
        }

        if (typeof db.loadFromKv === 'function') {
          await db.loadFromKv();
        }
      } else {
        console.warn('[cf-worker] HYPE_DB binding is missing');
      }

      if (typeof db.migrate === 'function') {
        await db.migrate();
      }

      if (typeof db.seed === 'function') {
        await db.seed();
      }

      app = createApp();

      server = createServer(app);
      server.listen(3000);

      nodeHandler = httpServerHandler({ port: 3000 });

      console.log('[cf-worker] Express and HTTP adapter initialized');
    } catch (error) {
      bootError = {
        message: error?.message || String(error),
        name: error?.name || 'Error',
        stack: error?.stack
          ? String(error.stack).slice(0, 2000)
          : null
      };

      console.error('[cf-worker] BOOT FAILED:', bootError);
    }
  })();

  return bootPromise;
}

function healthResponse() {
  const ok = !bootError && !handlerError && !!nodeHandler;

  return Response.json(
    {
      ok,
      runtime: 'cloudflare',
      time: new Date().toISOString(),
      adapterReady: !!nodeHandler,
      error: bootError?.message || handlerError || null,
      stack: bootError?.stack || null
    },
    { status: ok ? 200 : 500 }
  );
}

function rewriteAdminPath(url, env) {
  const adminPath = (
    env?.ADMIN_PANEL_PATH ||
    process.env.ADMIN_PANEL_PATH ||
    '/hq-control'
  ).replace(/\/$/, '');

  const pathname = url.pathname.replace(/\/$/, '') || '/';

  if (pathname === adminPath || pathname === '/admin') {
    url.pathname = '/admin.html';
    return true;
  }

  return false;
}

export default {
  async fetch(request, env, ctx) {
    await ensureBoot(env);

    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      if (!nodeHandler) return healthResponse();

      try {
        return await nodeHandler.fetch(request, env, ctx);
      } catch (error) {
        handlerError = error?.message || String(error);
        return healthResponse();
      }
    }

    const isApi =
      url.pathname.startsWith('/api/') ||
      url.pathname === '/tonconnect-manifest.json';

    if (isApi) {
      if (!nodeHandler) {
        return Response.json(
          {
            ok: false,
            runtime: 'cloudflare',
            error: bootError?.message || 'HTTP adapter not initialized'
          },
          { status: 500 }
        );
      }

      try {
        return await nodeHandler.fetch(request, env, ctx);
      } catch (error) {
        return Response.json(
          {
            ok: false,
            runtime: 'cloudflare',
            error: error?.message || String(error)
          },
          { status: 500 }
        );
      }
    }

    if (env?.ASSETS) {
      const rewrittenUrl = new URL(request.url);
      rewriteAdminPath(rewrittenUrl, env);

      const assetRequest =
        rewrittenUrl.pathname !== url.pathname
          ? new Request(rewrittenUrl.toString(), request)
          : request;

      return env.ASSETS.fetch(assetRequest);
    }

    return new Response('ASSETS binding is missing.', { status: 500 });
  },

  async scheduled(event, env, ctx) {
    await ensureBoot(env);

    if (bootError) {
      console.warn('[cron] Startup failed:', bootError.message);
      return;
    }

    try {
      const jobModule = unwrapModule(
        require('./jobs/miningPauseNotify')
      );

      if (typeof jobModule.runMiningPauseNotify === 'function') {
        await jobModule.runMiningPauseNotify();
      }
    } catch (error) {
      console.warn(
        '[cron] Mining notification failed:',
        error?.message || String(error)
      );
    }
  }
};
