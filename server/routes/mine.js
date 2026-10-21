const express = require('express');
const router = express.Router();
const { db, getSetting, transaction } = require('../db');
const { requireAuth } = require('../middleware/auth');

/**
 * GET /api/mine/status
 * Returns current energy, cooldown, balances, rate
 */
router.get('/status', requireAuth, (req, res) => {
  const user = refreshEnergy(req.user);
  const settings = {
    rate: parseFloat(getSetting('mining_rate', '1.25')),
    cooldownSeconds: parseInt(getSetting('mine_cooldown_seconds', '30'), 10),
    energyCost: parseInt(getSetting('energy_cost_per_mine', '5'), 10),
    dailyLimit: parseInt(getSetting('daily_mine_limit', '50'), 10),
    tokenSymbol: getSetting('token_symbol', 'HYPE')
  };

  let cooldownRemaining = 0;
  if (user.last_mine_at) {
    const last = new Date(user.last_mine_at).getTime();
    const elapsed = (Date.now() - last) / 1000;
    cooldownRemaining = Math.max(0, Math.ceil(settings.cooldownSeconds - elapsed));
  }

  // Daily reset check
  const daily = checkDailyReset(user);

  res.json({
    energy: user.energy,
    maxEnergy: user.max_energy,
    balance: Number(user.balance.toFixed(4)),
    holdingBalance: Number(user.holding_balance.toFixed(4)),
    minerLevel: user.miner_level,
    totalMined: Number(user.total_mined.toFixed(4)),
    dailyMined: daily.dailyMined,
    dailyLimit: settings.dailyLimit,
    cooldownRemaining,
    canMine: cooldownRemaining === 0 && user.energy >= settings.energyCost && daily.dailyMined < settings.dailyLimit,
    settings
  });
});

/**
 * POST /api/mine/tap
 * Perform one mining action
 */
router.post('/tap', requireAuth, (req, res) => {
  try {
    const result = transaction(() => {
      // Re-fetch user inside transaction for consistency
      let user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
      if (!user || user.is_banned) throw new Error('User banned or not found');

      user = refreshEnergy(user);

      const rate = parseFloat(getSetting('mining_rate', '1.25'));
      const cooldown = parseInt(getSetting('mine_cooldown_seconds', '30'), 10);
      const energyCost = parseInt(getSetting('energy_cost_per_mine', '5'), 10);
      const dailyLimit = parseInt(getSetting('daily_mine_limit', '50'), 10);
      const commissionPct = parseFloat(getSetting('referral_commission_pct', '5'));

      // Cooldown
      if (user.last_mine_at) {
        const elapsed = (Date.now() - new Date(user.last_mine_at).getTime()) / 1000;
        if (elapsed < cooldown) {
          throw new Error(`Cooldown active. Wait ${Math.ceil(cooldown - elapsed)}s`);
        }
      }

      // Energy
      if (user.energy < energyCost) {
        throw new Error('Not enough energy');
      }

      // Daily limit
      const daily = checkDailyReset(user);
      if (daily.dailyMined >= dailyLimit) {
        throw new Error('Daily mining limit reached');
      }

      const reward = rate;
      const newEnergy = user.energy - energyCost;
      const newBalance = user.balance + reward; // available immediately for simplicity; holding logic separate
      const newTotal = user.total_mined + reward;
      const newDaily = daily.dailyMined + 1;

      // Level: ~1 level per 10 HYPE mined (stable; not tied to tiny rates)
      const hypePerLevel = parseFloat(getSetting('hype_per_level', '10')) || 10;
      const newLevel = Math.min(
        parseInt(getSetting('max_miner_level', '1000'), 10),
        Math.max(1, Math.floor(Number(newTotal) / hypePerLevel) + 1)
      );

      db.prepare(`
        UPDATE users SET
          balance = ?, energy = ?, last_mine_at = datetime('now'),
          daily_mined = ?, total_mined = ?, miner_level = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(newBalance, newEnergy, newDaily, newTotal, newLevel, user.id);

      db.prepare(`
        INSERT INTO mining_log (user_id, amount, energy_used) VALUES (?, ?, ?)
      `).run(user.id, reward, energyCost);

      // Referral commission to holding
      if (user.referred_by) {
        const commission = reward * (commissionPct / 100);
        if (commission > 0) {
          db.prepare('UPDATE users SET holding_balance = holding_balance + ? WHERE id = ?').run(commission, user.referred_by);
          db.prepare('UPDATE referrals SET commission_earned = commission_earned + ? WHERE referred_id = ?').run(commission, user.id);
        }
      }

      db.prepare(`INSERT INTO activity_log (user_id, action, details) VALUES (?, 'mine', ?)`).run(
        user.id, JSON.stringify({ amount: reward, energy: energyCost })
      );

      return {
        reward,
        energy: newEnergy,
        balance: Number(newBalance.toFixed(4)),
        totalMined: Number(newTotal.toFixed(4)),
        minerLevel: newLevel,
        dailyMined: newDaily
      };
    });

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/mine/claim-holding
 * Unlock portion of holding balance to main balance (5% every 24h style)
 */
router.post('/claim-holding', requireAuth, (req, res) => {
  try {
    const result = transaction(() => {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
      if (!user) throw new Error('User not found');

      const pct = parseFloat(getSetting('holding_unlock_pct_per_day', '5')) / 100;
      const unlockAmount = user.holding_balance * pct;

      if (unlockAmount < 0.0001) {
        throw new Error('Nothing to claim');
      }

      const newHolding = user.holding_balance - unlockAmount;
      const newBalance = user.balance + unlockAmount;

      db.prepare(`
        UPDATE users SET balance = ?, holding_balance = ?, updated_at = datetime('now') WHERE id = ?
      `).run(newBalance, newHolding, user.id);

      return {
        unlocked: Number(unlockAmount.toFixed(4)),
        balance: Number(newBalance.toFixed(4)),
        holdingBalance: Number(newHolding.toFixed(4))
      };
    });

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

function refreshEnergy(user) {
  const regenPerHour = parseFloat(getSetting('energy_regen_per_hour', '20'));
  const maxEnergy = user.max_energy || 100;
  let energy = user.energy;

  if (user.last_energy_regen || user.created_at) {
    const last = new Date(user.last_energy_regen || user.created_at).getTime();
    const hours = (Date.now() - last) / 3600000;
    const regen = Math.floor(hours * regenPerHour);
    if (regen > 0) {
      energy = Math.min(maxEnergy, energy + regen);
      db.prepare('UPDATE users SET energy = ?, last_energy_regen = datetime(\'now\') WHERE id = ?').run(energy, user.id);
      user.energy = energy;
    }
  }
  return user;
}

function checkDailyReset(user) {
  const now = new Date();
  const resetAt = user.daily_reset_at ? new Date(user.daily_reset_at) : null;
  let dailyMined = user.daily_mined || 0;

  if (!resetAt || now.toDateString() !== resetAt.toDateString()) {
    dailyMined = 0;
    db.prepare('UPDATE users SET daily_mined = 0, daily_reset_at = datetime(\'now\') WHERE id = ?').run(user.id);
  }
  return { dailyMined };
}

module.exports = router;
