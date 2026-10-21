const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

/**
 * GET /api/leaderboard
 * Top 100 users by total HYPE mined (then balance as tie-break)
 */
router.get('/', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 100);

  const rows = db.prepare(`
    SELECT id, username, first_name, photo_url, miner_level, total_mined, balance, holding_balance
    FROM users
    WHERE is_banned = 0 OR is_banned IS NULL
    ORDER BY total_mined DESC, balance DESC
    LIMIT ?
  `).all(limit);

  const list = Array.isArray(rows) ? rows : [];
  const meId = req.user && req.user.id;

  let myRank = null;
  let myEntry = null;

  // Rank of current user (may be outside top 100)
  const allForRank = db.prepare(`
    SELECT id, total_mined, balance
    FROM users
    WHERE is_banned = 0 OR is_banned IS NULL
    ORDER BY total_mined DESC, balance DESC
  `).all();
  const ranked = Array.isArray(allForRank) ? allForRank : [];
  for (let i = 0; i < ranked.length; i++) {
    if (ranked[i].id === meId) {
      myRank = i + 1;
      break;
    }
  }

  const leaders = list.map((u, idx) => {
    const totalMined = Number(u.total_mined || 0);
    const bal = Number(u.balance || 0);
    const hold = Number(u.holding_balance || 0);
    const entry = {
      rank: idx + 1,
      id: u.id,
      username: u.username || null,
      firstName: u.first_name || null,
      photoUrl: u.photo_url || null,
      level: u.miner_level || 1,
      totalMined: Number(totalMined.toFixed(4)),
      balance: Number(bal.toFixed(4)),
      holding: Number(hold.toFixed(4)),
      isMe: u.id === meId
    };
    if (entry.isMe) myEntry = entry;
    return entry;
  });

  if (!myEntry && meId) {
    const me = req.user;
    myEntry = {
      rank: myRank,
      id: me.id,
      username: me.username || null,
      firstName: me.first_name || null,
      photoUrl: me.photo_url || null,
      level: me.miner_level || 1,
      totalMined: Number((Number(me.total_mined) || 0).toFixed(4)),
      balance: Number((Number(me.balance) || 0).toFixed(4)),
      holding: Number((Number(me.holding_balance) || 0).toFixed(4)),
      isMe: true
    };
  }

  res.json({
    leaders,
    myRank,
    myEntry,
    totalPlayers: ranked.length
  });
});

module.exports = router;
