/**
 * Cloudflare Workers entry — Express via node:http createServer + httpServerHandler
 *
 * Official pattern:
 *   const server = createServer(app); server.listen(3000);
 *   export default httpServerHandler({ port: 3000 });
 *
 * We keep a custom fetch so /api goes to Express and everything else to ASSETS.
 * Uses handleAsNodeRequest when available, else httpServerHandler(server).fetch.
 */
let app = null;
let server = null;
let booted = false;
let bootPromise = null;
let bootError = null;
let handlerError = null;
let nodeHandler = null;
let handleAsNodeRequest = null;

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
      process.env.NODE_ENV = process.env.NODE_ENV || 'production';

      if (env) {
        for (const key of Object.keys(env)) {
          if (typeof env[key] === 'string' && !process.env[key]) {
            process.env[key] = env[key];
          }
        }
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
        try {
          server.listen(3000);
        } catch (listenErr) {
          console.warn('[cf-worker] server.listen:', listenErr && listenErr.message);
        }
      } finally {
        if (process.versions && savedNodeVer !== undefined) {
          try {
            Object.defineProperty(process.versions, 'node', {
