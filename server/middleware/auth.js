const jwt = require('jsonwebtoken');
const { db } = require('../db');
const { validateInitData } = require('../utils/telegram');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-hype-miner-secret';

/**
 * Authenticate via Telegram initData (preferred for Mini App)
 * or via Bearer JWT (for subsequent API calls)
 */
function requireAuth(req, res, next) {
  // 1. Try Authorization header (JWT)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.userId);
      if (!user || user.is_banned) {
        return res.status(401).json({ error: 'User not found or banned' });
      }
      req.user = user;
      return next();
    } catch (e) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  }

  // 2. Try Telegram initData (first login / refresh)
  const initData = req.headers['x-telegram-init-data'] || req.body?.initData;
  if (initData) {
    const botToken = process.env.BOT_TOKEN;
    if (!botToken) {
      return res.status(500).json({ error: 'Server misconfigured: BOT_TOKEN missing' });
    }
    const result = validateInitData(initData, botToken);
    if (!result.valid) {
      return res.status(401).json({ error: result.error || 'Invalid Telegram data' });
    }
    if (!result.user || !result.user.id) {
      return res.status(401).json({ error: 'No user in initData' });
    }

    // Upsert user
    let user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(result.user.id));
    if (!user) {
      // Create new user – handled in auth route usually
      req.telegramUser = result.user;
      req.startParam = result.startParam;
      return next(); // allow auth route to create
    }
    if (user.is_banned) {
      return res.status(403).json({ error: 'Account banned' });
    }
    req.user = user;
    req.telegramUser = result.user;
    req.startParam = result.startParam;
    return next();
  }

  return res.status(401).json({ error: 'Authentication required' });
}

/**
 * Optional auth – attaches user if present
 */
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(authHeader.slice(7), JWT_SECRET);
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.userId);
      if (user && !user.is_banned) req.user = user;
    } catch (_) {}
  }
  next();
}

/**
 * Admin JWT auth
 */
function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Admin auth required' });
  }
  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET);
    if (payload.role !== 'admin' && payload.role !== 'superadmin') {
      return res.status(403).json({ error: 'Admin role required' });
    }
    const admin = db.prepare('SELECT id, username, role FROM admins WHERE id = ?').get(payload.adminId);
    if (!admin) return res.status(401).json({ error: 'Admin not found' });
    req.admin = admin;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid admin token' });
  }
}

function signUserToken(userId) {
  return jwt.sign({ userId, type: 'user' }, JWT_SECRET, { expiresIn: '7d' });
}

function signAdminToken(adminId, role) {
  return jwt.sign({ adminId, role, type: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
}

module.exports = {
  requireAuth,
  optionalAuth,
  requireAdmin,
  signUserToken,
  signAdminToken,
  JWT_SECRET
};
