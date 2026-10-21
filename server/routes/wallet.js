const express = require('express');
const router = express.Router();
const { db, getSetting, transaction, ensureUserBalances, getStore, saveStore, nextId } = require('../db');
const { requireAuth } = require('../middleware/auth');

/**
 * GET /api/wallet/overview
 */
router.get('/overview', requireAuth, (req, res) => {
  const user = ensureUserBalances(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id));
  const minUsdt = parseFloat(getSetting('min_usdt_deposit', '0.5'));
  const tonVerifyAmount = parseFloat(getSetting('ton_verify_amount', '0.1'));
  const tonTreasury =
    getSetting('treasury_wallet', '') ||
    process.env.TREASURY_WALLET ||
    process.env.TON_TREASURY ||
    '';
  const usdtAddress =
    getSetting('usdt_deposit_address', '') ||
    process.env.USDT_DEPOSIT_ADDRESS ||
    '';

  res.json({
    walletAddress: user.wallet_address || null,
    isVerified: !!user.is_verified,
    balances: {
      hype: Number((user.balance || 0).toFixed(4)),
      holding: Number((user.holding_balance || 0).toFixed(4)),
      ton: Number((user.ton_balance || 0).toFixed(6)),
      gram: Number((user.gram_balance || 0).toFixed(4)),
      usdtCredited: Number((user.usdt_credited || 0).toFixed(4))
    },
    // Withdrawals unlock only after 0.5 USDT (not TON verify)
    withdrawUnlocked: !!user.withdraw_unlocked || (user.usdt_credited || 0) >= minUsdt,
    minUsdtDeposit: minUsdt,
    // 0.1 TON verification fee → TON treasury
    tonVerify: {
      enabled: getSetting('ton_verify_enabled', 'true') === 'true',
      amount: tonVerifyAmount,
      address: tonTreasury,
      network: 'TON',
      label: 'TON Treasury'
    },
    // 0.5 USDT unlock → USDT treasury (separate)
    deposit: {
      enabled: getSetting('deposit_enabled', 'true') === 'true',
      address: usdtAddress,
      network: getSetting('usdt_deposit_network', 'BEP20'),
      amount: minUsdt,
      label: 'USDT Treasury'
    },
    withdrawalsEnabled: getSetting('withdrawals_enabled', 'false') === 'true',
    minWithdraw: parseFloat(getSetting('min_withdraw', '1'))
  });
});

/**
 * POST /api/wallet/address
 * Save / update TON withdrawal wallet
 */
router.post('/address', requireAuth, (req, res) => {
  const { address, disconnect } = req.body || {};

  // Disconnect
  if (disconnect || address === '' || address === null) {
    const store = getStore();
    const user = store.users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.wallet_address = null;
    user.updated_at = new Date().toISOString();
    saveStore();
    return res.json({ success: true, walletAddress: null, message: 'Wallet disconnected' });
  }

  if (!address || typeof address !== 'string' || address.length < 10) {
    return res.status(400).json({ error: 'Valid TON address required' });
  }
  const clean = address.trim();
  // EQ/UQ user-friendly, or raw 0:hex from TonConnect
  const okFriendly = /^[EUeu]Q[A-Za-z0-9_-]{46,48}$/.test(clean);
  const okRaw = /^0:[a-fA-F0-9]{64}$/.test(clean);
  if (!okFriendly && !okRaw) {
    return res.status(400).json({ error: 'Invalid TON address format' });
  }

  const store = getStore();
  const user = store.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.wallet_address = clean;
  // Linking address only — full verify still needs 0.1 TON to treasury
  user.updated_at = new Date().toISOString();
  saveStore();

  res.json({
    success: true,
    walletAddress: clean,
    isVerified: !!user.is_verified,
    message: user.is_verified
      ? 'Wallet updated'
      : 'Wallet linked. Send 0.1 TON to treasury to complete verification.'
  });
});

/** POST /api/wallet/disconnect */
router.post('/disconnect', requireAuth, (req, res) => {
  const store = getStore();
  const user = store.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.wallet_address = null;
  user.updated_at = new Date().toISOString();
  saveStore();
  res.json({ success: true, walletAddress: null });
});

/**
 * POST /api/wallet/verify-ton
 * User claims they paid 0.1 TON to TON treasury for verification
 * Body: { txHash?: string }
 */
router.post('/verify-ton', requireAuth, (req, res) => {
  if (getSetting('ton_verify_enabled', 'true') !== 'true') {
    return res.status(503).json({ error: 'TON verification temporarily closed' });
  }

  const tonTreasury =
    getSetting('treasury_wallet', '') ||
    process.env.TREASURY_WALLET ||
    process.env.TON_TREASURY ||
    '';
  if (!tonTreasury) {
    return res.status(503).json({ error: 'TON treasury address not configured yet' });
  }

  const amount = parseFloat(getSetting('ton_verify_amount', '0.1'));
  const txHash = (req.body.txHash || '').trim().slice(0, 128);
  if (!txHash) {
    return res.status(400).json({ error: 'TON transaction hash required' });
  }

  const store = getStore();
  const user = store.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.wallet_address) {
    return res.status(400).json({ error: 'Connect your TON wallet first' });
  }
  if (user.is_verified) {
    return res.json({ success: true, message: 'Already verified', isVerified: true });
  }

  const pending = (store.deposits || []).find(
    d => d.user_id === req.user.id && d.asset === 'TON' && d.status === 'pending'
  );
  if (pending) {
    return res.status(400).json({ error: 'You already have a pending TON verification. Wait for admin confirmation.' });
  }

  const id = nextId('deposits');
  store.deposits = store.deposits || [];
  store.deposits.push({
    id,
    user_id: req.user.id,
    amount,
    asset: 'TON',
    network: 'TON',
    to_address: tonTreasury,
    tx_hash: txHash,
    status: 'pending',
    purpose: 'verify',
    created_at: new Date().toISOString(),
    confirmed_at: null
  });
  saveStore();

  res.json({
    success: true,
    depositId: id,
    status: 'pending',
    message: '0.1 TON verification submitted. Admin will confirm shortly.'
  });
});

/**
 * POST /api/wallet/deposit
 * User submits USDT deposit claim (0.5 USDT to admin address)
 * Body: { txHash?: string, amount?: number }
 */
router.post('/deposit', requireAuth, (req, res) => {
  if (getSetting('deposit_enabled', 'true') !== 'true') {
    return res.status(503).json({ error: 'Deposits are temporarily closed' });
  }

  const depositAddress =
    getSetting('usdt_deposit_address', '') ||
    process.env.USDT_DEPOSIT_ADDRESS ||
    '';
  if (!depositAddress) {
    return res.status(503).json({ error: 'USDT treasury address not configured yet' });
  }

  const minUsdt = parseFloat(getSetting('min_usdt_deposit', '0.5'));
  const amount = parseFloat(req.body.amount) || minUsdt;
  if (amount < minUsdt) {
    return res.status(400).json({ error: `Minimum deposit is ${minUsdt} USDT` });
  }

  const txHash = (req.body.txHash || '').trim().slice(0, 128);

  const store = getStore();
  // prevent spam pending USDT deposits only
  const pending = (store.deposits || []).find(
    d => d.user_id === req.user.id && d.status === 'pending' && (d.asset || 'USDT') === 'USDT'
  );
  if (pending) {
    return res.status(400).json({ error: 'You already have a pending USDT deposit. Wait for confirmation.' });
  }

  const id = nextId('deposits');
  const row = {
    id,
    user_id: req.user.id,
    amount,
    asset: 'USDT',
    network: getSetting('usdt_deposit_network', 'BEP20'),
    to_address: depositAddress,
    tx_hash: txHash || null,
    status: 'pending',
    purpose: 'withdraw_unlock',
    created_at: new Date().toISOString(),
    confirmed_at: null
  };
  store.deposits = store.deposits || [];
  store.deposits.push(row);
  saveStore();

  res.json({
    success: true,
    depositId: id,
    status: 'pending',
    message: 'Deposit submitted. It will be credited after verification.'
  });
});

/**
 * GET /api/wallet/deposits
 */
router.get('/deposits', requireAuth, (req, res) => {
  const store = getStore();
  const list = (store.deposits || [])
    .filter(d => d.user_id === req.user.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 30);
  res.json({ deposits: list });
});

/**
 * POST /api/wallet/withdraw
 * Withdraw TON or GRAM to linked wallet.
 * Requires: wallet linked + (usdt deposit unlocked OR admin force) + withdrawals_enabled
 */
router.post('/withdraw', requireAuth, (req, res) => {
  const withdrawalsEnabled = getSetting('withdrawals_enabled', 'false') === 'true';
  const minWithdraw = parseFloat(getSetting('min_withdraw', '1'));
  const minUsdt = parseFloat(getSetting('min_usdt_deposit', '0.5'));

  if (!withdrawalsEnabled) {
    return res.status(503).json({
      error: 'Withdrawals temporarily unavailable',
      message: 'The withdrawal window is currently closed. Check back when network payouts reopen.'
    });
  }

  const user = ensureUserBalances(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id));
  if (!user.wallet_address) {
    return res.status(400).json({ error: 'Add your TON wallet first' });
  }

  const unlocked = !!user.withdraw_unlocked || (user.usdt_credited || 0) >= minUsdt;
  if (!unlocked) {
    return res.status(403).json({
      error: 'Deposit required',
      message: `Deposit ${minUsdt} USDT to unlock withdrawals`
    });
  }

  const asset = String(req.body.asset || 'TON').toUpperCase();
  if (!['TON', 'GRAM', 'HYPE'].includes(asset)) {
    return res.status(400).json({ error: 'Asset must be TON, GRAM or HYPE' });
  }

  const amount = parseFloat(req.body.amount);
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  const balKey = asset === 'TON' ? 'ton_balance' : asset === 'GRAM' ? 'gram_balance' : 'balance';
  const available = user[balKey] || 0;
  if (available < amount) {
    return res.status(400).json({ error: `Insufficient ${asset} balance` });
  }
  if (asset === 'HYPE' && amount < minWithdraw) {
    return res.status(400).json({ error: `Minimum HYPE withdrawal is ${minWithdraw}` });
  }

  try {
    const result = transaction(() => {
      const store = getStore();
      const u = store.users.find(x => x.id === user.id);
      if (!u || (u[balKey] || 0) < amount) throw new Error('Insufficient balance');

      u[balKey] = Number(((u[balKey] || 0) - amount).toFixed(8));
      u.updated_at = new Date().toISOString();

      const id = nextId('withdrawals');
      store.withdrawals.push({
        id,
        user_id: u.id,
        amount,
        asset,
        wallet_address: u.wallet_address,
        status: 'pending',
        tx_hash: null,
        admin_note: null,
        created_at: new Date().toISOString(),
        processed_at: null
      });
      saveStore();

      return { requestId: id, amount, asset, status: 'pending' };
    });

    res.json({
      success: true,
      ...result,
      message: 'Withdrawal request submitted. Processing after network confirmation.'
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/wallet/history
 */
router.get('/history', requireAuth, (req, res) => {
  const store = getStore();
  const withdrawals = (store.withdrawals || [])
    .filter(w => w.user_id === req.user.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 50);
  res.json({ withdrawals });
});

module.exports = router;
