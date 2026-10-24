const express = require('express');
const router = express.Router();
const { db, getSetting, transaction, ensureUserBalances, getStore, saveStore, nextId } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { verifyPaymentTx, normalizeHash, explorerLink } = require('../utils/txVerify');

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

  const feeAmount = parseFloat(getSetting('withdraw_fee_amount', getSetting('min_usdt_deposit', '0.5')));
  const feeAsset = getSetting('withdraw_fee_asset', 'USDT');
  const feeEnabled = getSetting('withdraw_fee_enabled', 'true') === 'true';
  const feePaid = !!user.withdraw_unlocked || (user.usdt_credited || 0) >= minUsdt || !!user.withdraw_fee_paid;
  const walletOk = !!(user.wallet_address && String(user.wallet_address).length > 10);
  const withdrawalsEnabled = getSetting('withdrawals_enabled', 'false') === 'true';
  const minWithdraw = parseFloat(getSetting('min_withdraw', '1'));
  // Fee paid users can place withdrawal requests (pending). Admin still pays out.
  const canRequest = walletOk && (!feeEnabled || feePaid);

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
    withdrawUnlocked: feePaid,
    withdrawFeePaid: feePaid,
    minUsdtDeposit: minUsdt,
    withdrawFee: {
      enabled: feeEnabled,
      amount: feeAmount,
      asset: feeAsset,
      address: usdtAddress,
      network: getSetting('usdt_deposit_network', 'BEP20'),
      paid: feePaid
    },
    conditions: {
      walletConnected: walletOk,
      feePaid: feePaid,
      feeRequired: feeEnabled,
      feeAmount: feeAmount,
      feeAsset: feeAsset,
      minWithdraw: minWithdraw,
      withdrawalsOpen: withdrawalsEnabled,
      canRequest: canRequest
    },
    tonVerify: {
      enabled: getSetting('ton_verify_enabled', 'true') === 'true',
      amount: tonVerifyAmount,
      address: tonTreasury,
      network: 'TON',
      label: 'TON Treasury'
    },
    deposit: {
      enabled: getSetting('deposit_enabled', 'true') === 'true',
      address: usdtAddress,
      network: getSetting('usdt_deposit_network', 'BEP20'),
      amount: feeAmount || minUsdt,
      label: 'Withdrawal fee / USDT Treasury'
    },
    withdrawalsEnabled,
    minWithdraw,
    paymentChannels: (getStore().payment_channels || []).filter(c => c.is_active !== 0 && c.is_active !== false)
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
router.post('/verify-ton', requireAuth, async (req, res) => {
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
  const txHash = (req.body.txHash || '').trim().slice(0, 256);
  if (!txHash || txHash.length < 16) {
    return res.status(400).json({ error: 'Transaction not valid', detail: 'TON tx hash required' });
  }

  const verify = await verifyPaymentTx({
    hash: txHash,
    network: 'TON',
    asset: 'TON',
    expectedTo: tonTreasury,
    expectedAmount: amount
  });
  if (!verify.valid) {
    return res.status(400).json({
      error: verify.error || 'Transaction not valid',
      detail: verify.detail || null,
      explorer: verify.explorer || null
    });
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
    verified: true,
    explorer: verify.explorer || explorerLink('TON', txHash),
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
router.post('/deposit', requireAuth, async (req, res) => {
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

  const txHash = (req.body.txHash || '').trim().slice(0, 256);
  if (!txHash || txHash.length < 16) {
    return res.status(400).json({ error: 'Transaction not valid', detail: 'Tx hash required' });
  }

  // On-chain verification — fake hash rejected
  const channelNet = getSetting('usdt_deposit_network', 'BEP20');
  const verify = await verifyPaymentTx({
    hash: txHash,
    network: channelNet,
    asset: 'USDT',
    expectedTo: depositAddress,
    expectedAmount: amount
  });
  if (!verify.valid) {
    return res.status(400).json({
      error: verify.error || 'Transaction not valid',
      detail: verify.detail || null,
      explorer: verify.explorer || null
    });
  }

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
    confirmed_at: null,
    verified: true,
    explorer: verify.explorer || explorerLink(channelNet, txHash),
    verify_detail: verify
  };
  store.deposits = store.deposits || [];
  store.deposits.push(row);
  saveStore();

  res.json({
    success: true,
    depositId: id,
    status: 'pending',
    message: 'Withdrawal fee submitted. After admin confirms, you can request a withdrawal — it will show as Pending in history.'
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
  const feeAmount = parseFloat(getSetting('withdraw_fee_amount', String(minUsdt)));
  const feeAsset = getSetting('withdraw_fee_asset', 'USDT');
  const feeEnabled = getSetting('withdraw_fee_enabled', 'true') === 'true';
  const feeAddress =
    getSetting('usdt_deposit_address', '') ||
    process.env.USDT_DEPOSIT_ADDRESS ||
    '';

  const user = ensureUserBalances(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id));
  if (!user) return res.status(404).json({ error: 'User not found' });

  const feePaid = !!user.withdraw_unlocked || (user.usdt_credited || 0) >= minUsdt || !!user.withdraw_fee_paid;
  const walletOk = !!(user.wallet_address && String(user.wallet_address).length > 10);

  const conditions = {
    walletConnected: walletOk,
    feePaid,
    feeRequired: feeEnabled,
    feeAmount,
    feeAsset,
    feeAddress,
    feeNetwork: getSetting('usdt_deposit_network', 'BEP20'),
    minWithdraw,
    withdrawalsOpen: withdrawalsEnabled,
    steps: [
      { id: 'wallet', label: 'Connect TON wallet', done: walletOk },
      { id: 'fee', label: feeEnabled ? (`Pay withdrawal fee: ${feeAmount} ${feeAsset}`) : 'No fee required', done: !feeEnabled || feePaid },
      { id: 'request', label: 'Submit withdrawal (shows as Pending in history)', done: false }
    ]
  };

  if (!walletOk) {
    return res.status(400).json({
      error: 'Wallet not connected',
      message: 'Connect your TON wallet first, then pay the withdrawal fee.',
      conditions,
      needFee: feeEnabled && !feePaid
    });
  }

  if (feeEnabled && !feePaid) {
    return res.status(400).json({
      error: 'Withdrawal fee required',
      message: `Pay the withdrawal fee first: ${feeAmount} ${feeAsset}. After admin confirms, you can request a withdrawal — status will show as Pending in history.`,
      conditions,
      needFee: true,
      fee: {
        amount: feeAmount,
        asset: feeAsset,
        address: feeAddress,
        network: getSetting('usdt_deposit_network', 'BEP20')
      }
    });
  }

  // Soft notice if window closed — still allow pending queue if fee paid
  if (!withdrawalsEnabled) {
    // allow request into pending queue so history shows pending
  }

  const amount = parseFloat(req.body.amount);
  const asset = String(req.body.asset || 'HYPE').toUpperCase();
  if (!amount || amount <= 0 || isNaN(amount)) {
    return res.status(400).json({ error: 'Enter a valid amount', conditions });
  }

  if (asset === 'HYPE' && amount < minWithdraw) {
    return res.status(400).json({
      error: `Minimum HYPE withdrawal is ${minWithdraw}`,
      conditions
    });
  }

  let balanceField = 'balance';
  if (asset === 'TON') balanceField = 'ton_balance';
  else if (asset === 'GRAM') balanceField = 'gram_balance';
  else if (asset === 'HYPE') balanceField = 'balance';
  else {
    return res.status(400).json({ error: 'Unsupported asset. Use HYPE or TON.', conditions });
  }

  const bal = Number(user[balanceField] || 0);
  if (bal < amount) {
    return res.status(400).json({
      error: `Insufficient ${asset} balance`,
      conditions
    });
  }

  let result;
  try {
    result = transaction(() => {
      const store = getStore();
      const u = store.users.find(x => x.id === user.id);
      if (!u) throw new Error('User not found');
      const cur = Number(u[balanceField] || 0);
      if (cur < amount) throw new Error('Insufficient balance');
      u[balanceField] = Number((cur - amount).toFixed(8));
      u.updated_at = new Date().toISOString();

      const id = nextId('withdrawals');
      store.withdrawals = store.withdrawals || [];
      store.withdrawals.push({
        id,
        user_id: user.id,
        amount,
        asset,
        wallet_address: u.wallet_address,
        status: 'pending',
        created_at: new Date().toISOString(),
        completed_at: null,
        note: withdrawalsEnabled ? null : 'Queued — payout window closed, admin will process'
      });
      return { requestId: id, amount, asset, status: 'pending' };
    });
  } catch (e) {
    return res.status(400).json({ error: e.message || 'Withdraw failed', conditions });
  }

  res.json({
    success: true,
    ...result,
    message: 'Withdrawal request submitted. Status: Pending — see history below. Admin will mark Successfully Paid after transfer.'
  });
});


router.get('/history', requireAuth, (req, res) => {
  const store = getStore();
  const withdrawals = (store.withdrawals || [])
    .filter(w => w.user_id === req.user.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 50);
  res.json({
    withdrawals: withdrawals.map(w => ({
      ...w,
      explorer: w.explorer || (w.payout_tx || w.tx_hash
        ? explorerLink(w.network || (String(w.asset || '').toUpperCase() === 'TON' ? 'TON' : 'BEP20'), w.payout_tx || w.tx_hash)
        : null)
    }))
  });
});

/**
 * GET /api/wallet/payment-channels
 * Active payment channels (admin-managed)
 */
router.get('/payment-channels', requireAuth, (req, res) => {
  const store = getStore();
  const list = (store.payment_channels || [])
    .filter(c => c.is_active !== 0 && c.is_active !== false)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  res.json({
    channels: list.map(c => ({
      id: c.id,
      name: c.name,
      asset: c.asset,
      network: c.network,
      address: c.address,
      amount: c.amount,
      purpose: c.purpose || 'fee',
      note: c.note || null
    }))
  });
});

/**
 * GET /api/wallet/success-feed
 * Recent successful withdrawals with explorer links (MRG-style social proof)
 */
router.get('/success-feed', requireAuth, (req, res) => {
  const store = getStore();
  const list = (store.withdrawals || [])
    .filter(w => w.status === 'completed' || w.status === 'paid')
    .sort((a, b) => String(b.completed_at || b.created_at || '').localeCompare(String(a.completed_at || a.created_at || '')))
    .slice(0, 30)
    .map(w => {
      const u = (store.users || []).find(x => x.id === w.user_id) || {};
      const hash = w.payout_tx || w.tx_hash || null;
      const net = w.network || (String(w.asset || '').toUpperCase() === 'TON' ? 'TON' : 'BEP20');
      return {
        id: w.id,
        username: u.username || u.first_name || 'Miner',
        amount: w.amount,
        asset: w.asset,
        wallet: w.wallet_address
          ? String(w.wallet_address).slice(0, 6) + '…' + String(w.wallet_address).slice(-4)
          : null,
        status: 'Withdrawal Successful',
        explorer: hash ? explorerLink(net, hash) : null,
        txHash: hash,
        at: w.completed_at || w.created_at
      };
    });
  res.json({ feed: list });
});

module.exports = router;
