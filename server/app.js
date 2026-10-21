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
      const chunks = [];
      let total = 0;
      for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > limitBytes) {
          res.status(413).json({ error: 'Payload too large' });
          return;
        }
        chunks.push(buf);
      }
      if (chunks.length === 0) {
        req.body = {};
        return next();
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      req.body = raw ? JSON.parse(raw) : {};
      next();
    } catch (err) {
      if (err instanceof SyntaxError) {
        res.status(400).json({ error: 'Invalid JSON body' });
        return;
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
  
