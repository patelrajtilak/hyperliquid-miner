const express = require('express');
const router = express.Router();
const { db, getSetting } = require('../db');
const { requireAuth } = require('../middleware/auth');

/**
 * GET /api/referral
 * Squad stats + invite link
 */
router.get('/', requireAuth, (req, res) => {
  const user = req.user;
  const botUsername = process.env.BOT_USERNAME || 'HypeMinerBot';

  const friends = db.prepare(`
    SELECT u.id, u.username, u.first_name, u.miner_level, u.total_mined, r.created_at, r.commission_earned
    FROM referrals r
    JOIN users u ON u.id = r.referred_id
    WHERE r.referrer_id = ?
    ORDER BY r.created_at DESC
  `).all(user.id);

  const stats = db.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(commission_earned), 0) as total_commission
    FROM referrals WHERE referrer_id = ?
  `).get(user.id);

  // JVault-style: https://t.me/BotUsername?start=TELEGRAM_ID
  const bot = String(botUsername || 'HypeMinerBot').replace(/^@/, '');
  const tgId = String(user.telegram_id || '').replace(/[^0-9]/g, '');
  const code = String(user.referral_code || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 64);

  // Primary invite link (channel buttons + share)
  const inviteLink = tgId
    ? `https://t.me/${bot}?start=${tgId}`
    : (code ? `https://t.me/${bot}?start=${code}` : `https://t.me/${bot}`);

  // Mini App direct open still works with startapp + same payload
  const miniAppLink = tgId
    ? `https://t.me/${bot}?startapp=${tgId}`
    : inviteLink;

  const channelButtonUrl = inviteLink;
  const startLink = inviteLink;
  const bonus = parseFloat(getSetting('referral_bonus', '25'));
  const appName = getSetting('app_name', 'HYPE MINER');
  const shareText =
    `⛏ Mine ${appName} with me!\n` +
    `Join with my link and we both earn.\n` +
    `${inviteLink}`;

  const list = Array.isArray(friends) ? friends : [];
  const count = (stats && stats.count != null) ? stats.count : list.length;
  const totalComm = (stats && stats.total_commission != null) ? Number(stats.total_commission) : 0;

  res.json({
    referralCode: code || user.referral_code || '',
    telegramId: tgId,
    inviteLink,
    channelButtonUrl,
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
      joinedAt: f.created_at,
      commissionEarned: Number((Number(f.commission_earned) || 0).toFixed(4))
    }))
  });
});

module.exports = router;
