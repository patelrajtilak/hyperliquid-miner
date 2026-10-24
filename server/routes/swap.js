const express = require('express');
const router = express.Router();
const { db, getSetting, transaction, ensureUserBalances, getStore, saveStore, nextId } = require('../db');
const { requireAuth } = require('../middleware/auth');

/**
 * GET /api/swap/rates
 */
router.get('/rates', requireAuth, (req, res) => {
  res.json({
    enabled: getSetting('swap_enabled', 'true') === 'true',
    minHype: parseFloat(getSetting('min_hype_swap', '1')),
    hypeToTon: parseFloat(getSetting('hype_to_ton_rate', '0.01')),
    hypeToGram: parseFloat(getSetting('hype_to_gram_rate', '0.5')),
    balances: {
      hype: Number((req.user.balance || 0).toFixed(4)),
      ton: Number((req.user.ton_balance || 0).toFixed(6)),
      gram: Number((req.user.gram_balance || 0).toFixed(4))
    }
  });
});

/**
 * POST /api/swap
 * Body: { amount: number, to: 'TON' }
 * Converts HYPE balance into TON credits at admin rate.
 */
router.post('/', requireAuth, (req, res) => {
  if (getSetting('swap_enabled', 'true') !== 'true') {
    return res.status(503).json({ error: 'Swap is temporarily closed' });
  }

  const to = String(req.body.to || '').toUpperCase();
  const amount = parseFloat(req.body.amount);
  const minHype = parseFloat(getSetting('min_hype_swap', '1'));

  if (to !== 'TON') {
    return res.status(400).json({ error: 'Only HYPE → TON swap is supported' });
  }
  if (!amount || amount < minHype) {
    return res.status(400).json({ error: `Minimum swap is ${minHype} HYPE` });
  }

  const rate = to === 'TON'
    ? parseFloat(getSetting('hype_to_ton_rate', '0.01'))
    : parseFloat(getSetting('hype_to_gram_rate', '0.5'));

  const outAmount = amount * rate;

  try {
    const result = transaction(() => {
      const store = getStore();
      const uid = req.user.id;
      let user = store.users.find(u => u.id === uid || String(u.id) === String(uid));
      if (!user) throw new Error('User not found');
      user = ensureUserBalances(user);
      const bal = Number(user.balance || 0);
      if (bal < amount) throw new Error('Insufficient HYPE balance (have ' + bal + ')');

      user.balance = Number((bal - amount).toFixed(6));
      if (to === 'TON') {
        user.ton_balance = Number(((Number(user.ton_balance) || 0) + outAmount).toFixed(8));
      } else {
        user.gram_balance = Number(((Number(user.gram_balance) || 0) + outAmount).toFixed(6));
      }
      user.updated_at = new Date().toISOString();

      store.swaps = store.swaps || [];
      store.swaps.push({
        id: nextId('swaps'),
        user_id: user.id,
        from: 'HYPE',
        to: to,
        amount_in: amount,
        amount_out: outAmount,
        rate: rate,
        created_at: new Date().toISOString()
      });

      return {
        swapped: amount,
        received: outAmount,
        asset: to,
        balance: {
          hype: Number(Number(user.balance).toFixed(4)),
          ton: Number((Number(user.ton_balance) || 0).toFixed(6)),
          gram: Number((Number(user.gram_balance) || 0).toFixed(4))
        }
      };
    });

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Swap failed' });
  }
});

module.exports = router;
