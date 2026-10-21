/**
 * Shared Express app factory — used by Node (index.js) and Cloudflare Worker (cf-worker.js)
 */
require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

function createApp() {
  const app = express();

  // Security & parsing
  app.use(helmet({
    contentSecurityPolicy: false, // Telegram Mini Apps need flexible CSP
    crossOriginEmbedderPolicy: false
  }));
  app.use(cors({
    origin: true,
    credentials: true
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

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
        runtime: process.env.CF_PAGES || process.env.CLOUDFLARE ? 'cloudflare' : 'node'
      });
    } catch (e) {
      res.json({ ok: true, time: new Date().toISOString() });
    }
  });

  // Static frontend
  const publicDir = path.join(__dirname, '..', 'public');

  // Dynamic TON Connect manifest (absolute URLs required)
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

  // Error handler
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
