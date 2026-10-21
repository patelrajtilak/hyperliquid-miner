const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

/**
 * GET /api/profile
 */
router.get('/', requireAuth, (req, res) => {
  const user = req.user;

  const recentMines = db.prepare(`
    SELECT amount, created_at FROM mining_log
    WHERE user_id = ? ORDER BY created_at DESC LIMIT 20
  `).all(user.id);

  const recentTasks = db.prepare(`
    SELECT t.title, ut.claimed_at, t.reward
    FROM user_tasks ut
    JOIN tasks t ON t.id = ut.task_id
    WHERE ut.user_id = ? AND ut.status = 'claimed'
    ORDER BY ut.claimed_at DESC LIMIT 10
  `).all(user.id);

  const referralCount = db.prepare('SELECT COUNT(*) as c FROM referrals WHERE referrer_id = ?').get(user.id).c;

  res.json({
    user: {
      id: user.id,
      telegramId: user.telegram_id,
      username: user.username,
      firstName: user.first_name,
      lastName: user.last_name,
      photoUrl: user.photo_url,
      balance: Number(user.balance.toFixed(4)),
      holdingBalance: Number(user.holding_balance.toFixed(4)),
      energy: user.energy,
      maxEnergy: user.max_energy,
      minerLevel: user.miner_level,
      totalMined: Number(user.total_mined.toFixed(4)),
      referralCode: user.referral_code,
      walletAddress: user.wallet_address,
      isVerified: !!user.is_verified,
      createdAt: user.created_at
    },
    referralCount,
    recentMines,
    recentTasks
  });
});

/**
 * POST /api/profile/wallet
 * Link TON wallet address (from TON Connect on frontend)
 */
router.post('/wallet', requireAuth, (req, res) => {
  const { address } = req.body;
  if (!address || typeof address !== 'string' || address.length < 10) {
    return res.status(400).json({ error: 'Valid TON address required' });
  }

  // Basic TON address format check (EQ... or UQ...)
  if (!/^[EUeu]Q[A-Za-z0-9_-]{46}$/.test(address) && !/^0:[a-fA-F0-9]{64}$/.test(address)) {
    return res.status(400).json({ error: 'Invalid TON address format' });
  }

  // Link only — verification requires 0.1 TON to treasury
  db.prepare(`
    UPDATE users SET wallet_address = ?, updated_at = datetime('now') WHERE id = ?
  `).run(address, req.user.id);

  db.prepare(`
    INSERT INTO activity_log (user_id, action, details) VALUES (?, 'wallet_link', ?)
  `).run(req.user.id, JSON.stringify({ address }));

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({
    success: true,
    walletAddress: address,
    isVerified: !!(user && user.is_verified)
  });
});

module.exports = router;
