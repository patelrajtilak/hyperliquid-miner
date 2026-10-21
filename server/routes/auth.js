const express = require('express');
const router = express.Router();
const { db, getSetting } = require('../db');
const {
  validateInitData,
  generateReferralCode,
  sendBotMessage,
  buildMiningPauseKeyboard,
  buildWelcomeText
} = require('../utils/telegram');
const { signUserToken, requireAuth } = require('../middleware/auth');

/**
 * POST /api/auth/telegram
 * Body: { initData: string }
 * Validates Telegram WebApp initData, creates/updates user, returns JWT + profile
 */
router.post('/telegram', (req, res) => {
  const { initData } = req.body;
  if (!initData) {
    return res.status(400).json({ error: 'initData required' });
  }

  const botToken = process.env.BOT_TOKEN;
  if (!botToken) {
    return res.status(500).json({ error: 'BOT_TOKEN not configured' });
  }

  const result = validateInitData(initData, botToken);
  if (!result.valid) {
    return res.status(401).json({ error: result.error || 'Invalid initData' });
  }

  // Explicit start param from client (start= / startapp=)
  if (!result.startParam && req.body && req.body.startParam) {
    result.startParam = String(req.body.startParam).trim();
  }

  const tgUser = result.user;
  if (!tgUser || !tgUser.id) {
    return res.status(400).json({ error: 'No user data in initData' });
  }

  const telegramId = String(tgUser.id);
  let user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);

  const referralCode = generateReferralCode(telegramId);
  let isNew = false;

  /**
   * Resolve referrer from start_param (invite code).
   * Same device + different Telegram account is ALLOWED and counts in refer list.
   * Only blocked: referring yourself (same telegram account).
   */
  function findReferrerId(startParam, newTelegramId) {
    if (!startParam) return null;
    const raw = String(startParam).trim();
    if (!raw) return null;

    // ?start=8990854464 → referrer by telegram_id
    const asTgId = raw.replace(/[^0-9]/g, '');
    if (asTgId && /^\d{5,15}$/.test(asTgId)) {
      const byTg = db.prepare('SELECT id, telegram_id FROM users WHERE telegram_id = ?').get(asTgId);
      if (byTg) {
        if (String(byTg.telegram_id) === String(newTelegramId)) return null;
        return byTg.id;
      }
    }

    // Fallback old HYPE… referral codes
    const code = raw.toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    if (!code) return null;
    let referrer = db.prepare('SELECT id, telegram_id FROM users WHERE referral_code = ?').get(code);
    if (!referrer) {
      referrer = db.prepare('SELECT id, telegram_id FROM users WHERE referral_code = ?').get(raw);
    }
    if (!referrer) return null;
    if (String(referrer.telegram_id) === String(newTelegramId)) return null;
    return referrer.id;
  }

  function applyReferralBonus(referrerId, newUserId) {
    if (!referrerId || !newUserId) return;
    // Already linked?
    const existing = db.prepare('SELECT id FROM referrals WHERE referred_id = ?').get(newUserId);
    if (existing) return;
    const bonus = parseFloat(getSetting('referral_bonus', '25'));
    db.transaction(() => {
      db.prepare('INSERT INTO referrals (referrer_id, referred_id, bonus_paid) VALUES (?, ?, 1)').run(referrerId, newUserId);
      db.prepare('UPDATE users SET holding_balance = holding_balance + ? WHERE id = ?').run(bonus, referrerId);
      db.prepare(`INSERT INTO activity_log (user_id, action, details) VALUES (?, 'referral_bonus', ?)`).run(
        referrerId,
        JSON.stringify({ referred: newUserId, amount: bonus })
      );
    })();
  }

  if (!user) {
    isNew = true;
    const referredBy = findReferrerId(result.startParam, telegramId);

    const insert = db.prepare(`
      INSERT INTO users (
        telegram_id, username, first_name, last_name, photo_url,
        referral_code, referred_by, energy, max_energy, daily_reset_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    const maxEnergy = parseInt(getSetting('energy_cost_per_mine', '5'), 10) * 20 || 100;
    const info = insert.run(
      telegramId,
      tgUser.username || null,
      tgUser.first_name || null,
      tgUser.last_name || null,
      tgUser.photo_url || null,
      referralCode,
      referredBy,
      maxEnergy,
      maxEnergy
    );

    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    applyReferralBonus(referredBy, user.id);

    db.prepare(`INSERT INTO activity_log (user_id, action, details) VALUES (?, 'register', ?)`).run(user.id, JSON.stringify({ telegram_id: telegramId }));
    // DIGGO-style welcome with Open + Join Community buttons
    try {
      const appName = getSetting('app_name', 'HYPE MINER');
      const text = buildWelcomeText(appName);
      const keyboard = buildMiningPauseKeyboard();
      sendBotMessage(telegramId, text, keyboard).catch(() => {});
    } catch (_) {}
  } else {
    db.prepare(`
      UPDATE users SET username = ?, first_name = ?, last_name = ?, photo_url = ?, updated_at = datetime('now') WHERE id = ?
    `).run(tgUser.username || user.username, tgUser.first_name || user.first_name, tgUser.last_name || user.last_name, tgUser.photo_url || user.photo_url, user.id);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);

    // Late referral: existing user never referred, opened invite link from another TG account (same device OK)
    if (!user.referred_by && result.startParam) {
      const referredBy = findReferrerId(result.startParam, telegramId);
      if (referredBy) {
        db.prepare('UPDATE users SET referred_by = ? WHERE id = ?').run(referredBy, user.id);
        applyReferralBonus(referredBy, user.id);
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      }
    }
  }

  if (user.is_banned) {
    return res.status(403).json({ error: 'Account is banned' });
  }

  const token = signUserToken(user.id);

  res.json({
    token,
    isNew,
    user: sanitizeUser(user)
  });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: sanitizeUser(req.user) });
});

function sanitizeUser(u) {
  const n = (v) => Number((Number(v) || 0).toFixed(4));
  return {
    id: u.id,
    telegramId: u.telegram_id,
    username: u.username,
    firstName: u.first_name,
    lastName: u.last_name,
    photoUrl: u.photo_url,
    balance: n(u.balance),
    holdingBalance: n(u.holding_balance),
    energy: u.energy || 0,
    maxEnergy: u.max_energy || 100,
    minerLevel: u.miner_level || 1,
    totalMined: n(u.total_mined),
    referralCode: u.referral_code,
    walletAddress: u.wallet_address,
    isVerified: !!u.is_verified,
    createdAt: u.created_at
  };
}

module.exports = router;

/**
 * POST /api/auth/session
 * Session bootstrap when Telegram initData is unavailable (local preview).
 * Disabled in production unless ALLOW_DEV_LOGIN=true.
 */
router.post('/session', (req, res) => {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEV_LOGIN !== 'true') {
    return res.status(403).json({ error: 'Open HYPE Miner from Telegram' });
  }

  const name = (req.body && req.body.name) || 'Miner';
  const rawId = (req.body && req.body.clientId) || 'web_' + Date.now();
  const telegramId = 'web_' + String(rawId).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32);

  let user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  if (!user) {
    const referralCode = require('../utils/telegram').generateReferralCode(telegramId);
    const maxEnergy = parseInt(getSetting('energy_cost_per_mine', '5'), 10) * 20 || 100;
    const info = db.prepare(`
      INSERT INTO users (
        telegram_id, username, first_name, last_name, photo_url,
        referral_code, referred_by, energy, max_energy, daily_reset_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(telegramId, name, name, null, null, referralCode, null, maxEnergy, maxEnergy);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  }

  const token = signUserToken(user.id);
  res.json({ token, isNew: false, user: sanitizeUser(user) });
});
