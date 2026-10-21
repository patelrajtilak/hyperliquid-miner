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
 * Body: { amount: number, to: 'TON' | 'GRAM' }
 * Converts HYPE balance into TON or GRAM credits at admin rates.
 */
router.post('/', requireAuth, (req, res) => {
  if (getSetting('swap_enabled', 'true') !== 'true') {
    return res.status(503).json({ error: 'Swap is temporarily closed' });
  }

  const to = String(req.body.to || '').toUpperCase();
  const amount = parseFloat(req.body.amount);
  const minHype = parseFloat(getSetting('min_hype_swap', '1'));

  if (!['TON', 'GRAM'].includes(to)) {
    return res.status(400).json({ error: 'Choose TON or GRAM' });
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
      const user = ensureUserBalances(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id));
      if (!user) throw new Error('User not found');
      if ((user.balance || 0) < amount) throw new Error('Insufficient HYPE balance');

      user.balance = Number((user.balance - amount).toFixed(6));
      if (to === 'TON') {
        user.ton_balance = Number(((user.ton_balance || 0) + outAmount).toFixed(8));
      } else {
        user.gram_balance = Number(((user.gram_balance || 0) + outAmount).toFixed(6));
      }
      user.updated_at = new Date().toISOString();

      // persist via store
      const store = getStore();
      const idx = store.users.findIndex(u => u.id === user.id);
      if (idx >= 0) store.users[idx] = user;
      store.swaps = store.swaps || [];
      store.swaps.push({
        id: nextId('swaps'),
        user_id: user.id,
        from: 'HYPE',
        to,
        amount_in: amount,
        amount_out: outAmount,
        rate,
        created_at: new Date().toISOString()
      });
      saveStore();

      return {
        swapped: amount,
        received: outAmount,
        asset: to,
        balance: {
          hype: Number(user.balance.toFixed(4)),
          ton: Number((user.ton_balance || 0).toFixed(6)),
          gram: Number((user.gram_balance || 0).toFixed(4))
        }
      };
    });

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
