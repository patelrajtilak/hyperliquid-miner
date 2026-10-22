/**
 * Shared Express app factory — used by Node (index.js) and Cloudflare Worker (cf-worker.js)
 *
 * Cloudflare note: we deliberately avoid express.json() / body-parser.
 * body-parser → raw-body → iconv-lite triggers
 *   "Uncaught TypeError: require_streams(...) is not a function"
 * under Wrangler nodejs_compat bundling. A tiny native stream collector
 * works on both Node and the Workers node:http adapter.
 */
require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
// morgan required lazily on Node only (uses new Function — blocked on CF Workers)
const rateLimit = require('express-rate-limit');

const isCloudflare = () =>
  !!(process.env.CLOUDFLARE || process.env.CF_PAGES || process.env.CF_WORKER);

/**
 * Lightweight JSON body parser — no body-parser / iconv-lite / stream polyfill issues.
 * Works with Node IncomingMessage and the Cloudflare node:http adapter.
 */
function jsonBodyParser(limitBytes = 1 * 1024 * 1024) {
  return async function parseJson(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      return next();
    }
    // Already parsed by a previous middleware
    if (req.body !== undefined && req.body !== null && typeof req.body === 'object') {
      return next();
    }
    const ct = (req.headers['content-type'] || '').toLowerCase();
    if (!ct.includes('application/json')) {
      return next();
    }

    try {
      // If adapter already parsed body
      if (typeof req.body === 'string' && req.body) {
        try { req.body = JSON.parse(req.body); } catch (_) { req.body = {}; }
        return next();
      }

      const chunks = [];
      let total = 0;
      const readBody = (async () => {
        for await (const chunk of req) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buf.length;
          if (total > limitBytes) {
            const err = new Error('Payload too large');
            err.status = 413;
            throw err;
          }
          chunks.push(buf);
        }
      })();

      // Cloudflare node:http streams can hang — never wait forever
      await Promise.race([
        readBody,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Body read timeout')), 8000)
        )
      ]);

      if (chunks.length === 0) {
        req.body = {};
        return next();
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      req.body = raw ? JSON.parse(raw) : {};
      next();
    } catch (err) {
      if (err && err.status === 413) {
        res.status(413).json({ error: 'Payload too large' });
        return;
      }
      if (err instanceof SyntaxError) {
        res.status(400).json({ error: 'Invalid JSON body' });
        return;
      }
      if (err && /timeout/i.test(err.message || '')) {
        // Empty body fallback so auth can still try header-based initData
        req.body = req.body && typeof req.body === 'object' ? req.body : {};
        return next();
      }
      next(err);
    }
  };
}

function createApp() {
  const app = express();
  const onCF = isCloudflare();

  // Security & parsing
  app.use(helmet({
    contentSecurityPolicy: false, // Telegram Mini Apps need flexible CSP
    crossOriginEmbedderPolicy: false
  }));
  app.use(cors({
    origin: true,
    credentials: true
  }));

  // CF-safe JSON parser (replaces express.json / body-parser)
  app.use(jsonBodyParser(1 * 1024 * 1024));

  // Morgan uses new Function() to compile format tokens — forbidden on
  // Cloudflare Workers (EvalError: Code generation from strings disallowed).
  // Keep Morgan on Node; use a tiny static logger on CF.
  if (!onCF) {
    const morgan = require('morgan');
    app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
  } else {
    app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        try {
          console.log(req.method, req.url, res.statusCode, (Date.now() - start) + 'ms');
        } catch (_) {}
      });
      next();
    });
  }

  // Rate limiting
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, slow down' }
  });
  const mineLimiter = rateLimit({
    windowMs: 10 * 1000,
    max: 5,
    message: { error: 'Mining too fast' }
  });

  app.use('/api', apiLimiter);

  // Routes
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/mine', mineLimiter, require('./routes/mine'));
  app.use('/api/tasks', require('./routes/tasks'));
  app.use('/api/referral', require('./routes/referral'));
  app.use('/api/profile', require('./routes/profile'));
  app.use('/api/wallet', require('./routes/wallet'));
  app.use('/api/swap', require('./routes/swap'));
  app.use('/api/market', require('./routes/market'));
  app.use('/api/leaderboard', require('./routes/leaderboard'));
  app.use('/api/admin', require('./routes/admin'));

  // Health
  app.get('/api/health', (req, res) => {
    try {
      const { getStore } = require('./db');
      const s = getStore();
      res.json({
        ok: true,
        users: (s.users || []).length,
        tasks: (s.tasks || []).length,
        time: new Date().toISOString(),
        runtime: onCF ? 'cloudflare' : 'node'
      });
    } catch (e) {
      res.json({ ok: true, time: new Date().toISOString(), runtime: onCF ? 'cloudflare' : 'node' });
    }
  });

  // Dynamic TON Connect manifest (absolute URLs required) — always via Express
  app.get('/tonconnect-manifest.json', (req, res) => {
    const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
    const host = req.get('x-forwarded-host') || req.get('host') || 'localhost';
    const origin = process.env.WEBAPP_URL || `${proto}://${host}`;
    const base = origin.replace(/\/$/, '');
    res.json({
      url: base,
      name: 'HYPE MINER',
      iconUrl: base + '/assets/hype-coin.png',
      termsOfUseUrl: base,
      privacyPolicyUrl: base
    });
  });

  // Static frontend + SPA — only on classic Node hosts.
  // On Cloudflare Workers the public/ folder is served by the [assets] binding
  // (see wrangler.toml + cf-worker.js). express.static / sendFile would fail
  // because the Worker bundle has no real filesystem for those files.
  if (!onCF) {
    const publicDir = path.join(__dirname, '..', 'public');

    app.use(express.static(publicDir, {
      index: 'index.html',
    }));

    // Admin panel — open in browser (not inside Mini App)
    const adminPath = (process.env.ADMIN_PANEL_PATH || '/hq-control').replace(/\/$/, '');
    const adminPaths = new Set([adminPath, adminPath + '/', '/admin', '/admin/']);
    app.get([...adminPaths], (req, res) => {
      res.sendFile(path.join(publicDir, 'admin.html'));
    });
    app.get('/admin.html', (req, res) => {
      if (adminPath === '/admin.html' || adminPath === '/admin') {
        return res.sendFile(path.join(publicDir, 'admin.html'));
      }
      res.status(404).send('Not found');
    });

    // SPA fallback
    app.get('*', (req, res) => {
      if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
      res.sendFile(path.join(publicDir, 'index.html'));
    });
  } else {
    // On CF: only answer API + dynamic routes. Everything else falls through
    // to the assets handler in cf-worker.js.
    app.use((req, res) => {
      if (req.path.startsWith('/api')) {
        return res.status(404).json({ error: 'Not found' });
      }
      // Signal to the outer Worker that this is not an API route
      res.status(404).set('X-CF-Assets', '1').end();
    });
  }

  // Error handler
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

const _appExports = { createApp, isCloudflare };
module.exports = _appExports;
module.exports.default = _appExports;
