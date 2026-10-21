/**
 * HYPE MINER — Cloudflare Worker entry
 * Express + node:http + Cloudflare HTTP server adapter
 *
 * Keeps:
 * - HYPE_DB KV persistence
 * - Express API routes
 * - Static frontend via ASSETS
 * - /api/health diagnostics
 * - Scheduled mining notifications
 */

import { createServer } from 'node:http';
import { httpServerHandler } from 'cloudflare:node';

let app = null;
let server = null;
let booted = false;
let bootPromise = null;
let bootError = null;
let nodeHandler = null;
let handlerError = null;

function unwrapModule(mod, exportName) {
  if (mod && typeof mod[exportName] === 'function') return mod;
  if (mod?.default && typeof mod.default[exportName] === 'function') {
    return mod.default;
  }
  return mod?.default || mod;
}

async function ensureBoot(env) {
  if (booted) return;
  if (bootPromise) return bootPromise;

  bootPromise = (async () => {
    try {
      process.env.CLOUDFLARE = '1';

      if (env) {
        for (const [key, value] of Object.entries(env)) {
          if (typeof value === 'string' && !process.env[key]) {
            process.env[key] = value;
          }
        }
      }

      const savedNodeVer =
        process.versions &&
        typeof process.versions.node === 'string'
          ? process.versions.node
          : undefined;

      try {
        // Workaround for iconv-lite's Node-version detection on Workers.
        if (process.versions && savedNodeVer !== undefined) {
          try {
            Object.defineProperty(process.versions, 'node', {
              value: undefined,
              configurable: true
            });
          } catch (_) {}
        }

        const db = unwrapModule(require('./db'), 'setKvBinding');
        const appModule = unwrapModule(require('./app'), 'createApp');
        const createApp = appModule.createApp;

        if (typeof db.setKvBinding !== 'function') {
          throw new Error(
            'db.setKvBinding missing. Exports: ' +
            Object.keys(db || {}).join(', ')
          );
        }

        if (typeof createApp !== 'function') {
          throw new Error(
            'createApp missing. Exports: ' +
            Object.keys(appModule || {}).join(', ')
          );
        }

        // Connect Cloudflare KV before loading application data.
        if (env?.HYPE_DB) {
          db.setKvBinding(env.HYPE_DB);

          if (typeof db.loadFromKv === 'function') {
            await db.loadFromKv();
          }
        }

        if (typeof db.migrate === 'function') {
          await db.migrate();
        }

        if (typeof db.seed === 'function') {
          await db.seed();
        }

        app = createApp();

        // Express must be attached to a Node HTTP server.
        server = createServer(app);

        // Cloudflare's adapter uses the server's request listener.
        nodeHandler = httpServerHandler({ port: 3000 });

        booted = true;
        bootError = null;
        handlerError = null;

        console.log('[cf-worker] Express app and HTTP adapter initialized');
      } finally {
        if (process.versions && savedNodeVer !== undefined) {
          try {
            Object.defineProperty(process.versions, 'node', {
              value: savedNodeVer,
              configurable: true
            });
          } catch (_) {}
        }
      }
    } catch (error) {
      bootError = {
        message: error?.message || String(error),
        name: error?.name || 'Error',
        stack: error?.stack
          ? String(error.stack).slice(0, 2000)
          : null
      };

      console.error(
        '[cf-worker] BOOT FAILED:',
        bootError.message,
        bootError.stack
      );
    }
  })();

  return bootPromise;
}

function healthResponse(extra = {}) {
  const ok = !bootError && !handlerError && !!nodeHandler;

  return Response.json(
    {
      ok,
      time: new Date().toISOString(),
      runtime: 'cloudflare',
      booted,
      adapterReady: !!nodeHandler,
      ...(bootError
        ? {
            error: bootError.message,
            errorName: bootError.name,
            stack: bootError.stack
          }
        : {}),
      ...(handlerError ? { handlerError } : {}),
      ...extra
    },
    { status: ok ? 200 : 500 }
  );
}

function rewriteAdminPath(url) {
  const adminPath = (
    process.env.ADMIN_PANEL_PATH || '/hq-control'
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
    const pathname = url.pathname;

    if (pathname === '/api/health') {
      if (bootError) return healthResponse();

      if (!nodeHandler) {
        return healthResponse({
          note: 'HTTP adapter is not initialized'
        });
      }

      try {
        return await nodeHandler.fetch(request, env, ctx);
      } catch (error) {
        handlerError = error?.message || String(error);

        console.error(
          '[cf-worker] HTTP handler failed:',
          handlerError
        );

        return healthResponse({
          phase: 'http-handler'
        });
      }
    }

    const isApi =
      pathname.startsWith('/api/') ||
      pathname === '/tonconnect-manifest.json';

    if (isApi) {
      if (bootError) {
        return Response.json(
          {
            ok: false,
            runtime: 'cloudflare',
            error: bootError.message,
            errorName: bootError.name,
            stack: bootError.stack
          },
          { status: 500 }
        );
      }

      if (!nodeHandler) {
        return Response.json(
          {
            ok: false,
            error: 'HTTP adapter is not initialized',
            runtime: 'cloudflare'
          },
          { status: 503 }
        );
      }

      try {
        return await nodeHandler.fetch(request, env, ctx);
      } catch (error) {
        console.error(
          '[cf-worker] API handler failed:',
          error?.message || String(error)
        );

        return Response.json(
          {
            ok: false,
            error: error?.message || String(error),
            runtime: 'cloudflare',
            phase: 'api-handler'
          },
          { status: 500 }
        );
      }
    }

    // Frontend and admin panel assets.
    if (env?.ASSETS) {
      try {
        const rewrittenUrl = new URL(request.url);
        rewriteAdminPath(rewrittenUrl);

        const assetRequest =
          rewrittenUrl.pathname !== url.pathname
            ? new Request(rewrittenUrl.toString(), request)
            : request;

        return await env.ASSETS.fetch(assetRequest);
      } catch (error) {
        return new Response(
          'Assets error: ' + (error?.message || String(error)),
          { status: 500 }
        );
      }
    }

    return new Response(
      'Static assets are not configured. Check the ASSETS binding in wrangler.toml.',
      { status: 500 }
    );
  },

  async scheduled(event, env, ctx) {
    await ensureBoot(env);

    if (bootError) {
      console.warn(
        '[cron] skipped because startup failed:',
        bootError.message
      );
      return;
    }

    try {
      const jobModule = unwrapModule(
        require('./jobs/miningPauseNotify'),
        'runMiningPauseNotify'
      );

      if (typeof jobModule.runMiningPauseNotify === 'function') {
        await jobModule.runMiningPauseNotify();
      }
    } catch (error) {
      console.warn(
        '[cron] mining pause notification failed:',
        error?.message || String(error)
      );
    }
  }
};
