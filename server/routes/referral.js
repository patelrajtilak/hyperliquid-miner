const express = require('express');
const router = express.Router();
const { db, getSetting, getStore, saveStore, nextId } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { get } = require('../runtime-config');

/**
 * GET /api/referral
 * Squad = everyone YOU referred (referrals table + users.referred_by).
 * Shows mined total so leaderboard climbers still appear in your invite list.
 */
router.get('/', requireAuth, (req, res) => {
  const user = req.user;
  const botUsername = (get('BOT_USERNAME', '') || process.env.BOT_USERNAME || 'hyperliquid_miner_bot').replace(/^@/, '');

  // Primary: referrals table
  let friends = db.prepare(`
    SELECT u.id, u.username, u.first_name, u.miner_level, u.total_mined, r.created_at, r.commission_earned
    FROM referrals r
    JOIN users u ON u.id = r.referred_id
    WHERE r.referrer_id = ?
    ORDER BY r.created_at DESC
  `).all(user.id);

  if (!Array.isArray(friends)) friends = [];

  // Fallback / merge: users who have referred_by = me but missing from referrals table
  // (can happen if bonus path partially failed or old data)
  try {
    const store = typeof getStore === 'function' ? getStore() : null;
    if (store && Array.isArray(store.users)) {
      const seen = new Set(friends.map(f => f.id));
      const orphans = store.users.filter(
        u => u.referred_by === user.id && !seen.has(u.id)
      );
      for (const u of orphans) {
        // Heal: create missing referral row so list stays consistent
        try {
          const existing = db.prepare('SELECT id FROM referrals WHERE referred_id = ?').get(u.id);
          if (!existing) {
            db.prepare(
              'INSERT INTO referrals (referrer_id, referred_id, bonus_paid) VALUES (?, ?, 0)'
            ).run(user.id, u.id);
          }
        } catch (_) {}
        friends.push({
          id: u.id,
          username: u.username,
          first_name: u.first_name,
          miner_level: u.miner_level || 1,
          total_mined: u.total_mined || 0,
          created_at: u.created_at || null,
          commission_earned: 0
        });
      }
    }
  } catch (_) {}

  // Rank by total_mined (leaderboard position among all users)
  let rankMap = {};
  try {
    const leaders = db.prepare(`
      SELECT id, total_mined FROM users ORDER BY total_mined DESC LIMIT 500
    `).all();
    const list = Array.isArray(leaders) ? leaders : [];
    list.forEach((row, i) => {
      rankMap[row.id] = i + 1;
    });
  } catch (_) {}

  // Sort: highest mined first, then newest
  friends.sort((a, b) => {
    const dm = (Number(b.total_mined) || 0) - (Number(a.total_mined) || 0);
    if (dm !== 0) return dm;
    return String(b.created_at || '').localeCompare(String(a.created_at || ''));
  });

  const stats = db.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(commission_earned), 0) as total_commission
    FROM referrals WHERE referrer_id = ?
  `).get(user.id);

  const tgId = String(user.telegram_id || '').replace(/[^0-9]/g, '');
  const code = String(user.referral_code || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 64);

  const payload = tgId || code;
  const inviteLink = payload
    ? `https://t.me/${botUsername}?startapp=${payload}`
    : `https://t.me/${botUsername}`;
  const startLink = payload
    ? `https://t.me/${botUsername}?start=${payload}`
    : inviteLink;
  const miniAppLink = inviteLink;

  const bonus = parseFloat(getSetting('referral_bonus', '25'));
  const appName = getSetting('app_name', 'HYPE MINER');
  const shareText =
    `⛏ Mine ${appName} with me!\n` +
    `Join with my link and we both earn.\n` +
    `${inviteLink}`;

  const list = friends;
  const count = Math.max(
    (stats && stats.count != null) ? stats.count : 0,
    list.length
  );
  const totalComm =
    stats && stats.total_commission != null ? Number(stats.total_commission) : 0;

  res.json({
    referralCode: code || user.referral_code || '',
    telegramId: tgId,
    inviteLink,
    startLink,
    miniAppLink,
    shareText,
    friendsCount: count,
    totalCommission: Number(totalComm.toFixed(4)),
    bonusPerInvite: bonus,
    commissionPct: parseFloat(getSetting('referral_commission_pct', '5')),
    friends: list.map(f => ({
      id: f.id,
      username: f.username,
      firstName: f.first_name,
      level: f.miner_level || 1,
      totalMined: Number((Number(f.total_mined) || 0).toFixed(2)),
      rank: rankMap[f.id] || null,
      joinedAt: f.created_at,
      commissionEarned: Number((Number(f.commission_earned) || 0).toFixed(4))
    }))
  });
});

module.exports = router;
