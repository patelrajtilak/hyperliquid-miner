const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { db, getSetting, setSetting, getAllSettings, transaction } = require('../db');
const { requireAdmin, requireAuth, signAdminToken } = require('../middleware/auth');

/**
 * POST /api/admin/login
 */
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = signAdminToken(admin.id, admin.role);
  res.json({
    token,
    admin: { id: admin.id, username: admin.username, role: admin.role }
  });
});

/** Owner Telegram IDs with full HQ (default: 8990854464) */
function getOwnerTelegramIds() {
  const raw = process.env.ADMIN_TELEGRAM_IDS || '8990854464';
  return String(raw).split(',').map(s => s.trim()).filter(Boolean);
}
function isOwnerTelegramId(tgId) {
  return getOwnerTelegramIds().includes(String(tgId || '').trim());
}

/**
 * POST /api/admin/owner-login
 * Full HQ power for owner Telegram only — no password.
 */
router.post('/owner-login', requireAuth, (req, res) => {
  const tgId = String(req.user.telegram_id || '');
  if (!isOwnerTelegramId(tgId)) {
    return res.status(403).json({ error: 'HQ access denied' });
  }
  let admin = db.prepare('SELECT * FROM admins WHERE username = ?').get('owner_' + tgId);
  if (!admin) {
    const hash = bcrypt.hashSync('owner-' + tgId, 10);
    try {
      const info = db.prepare(
        'INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)'
      ).run('owner_' + tgId, hash, 'superadmin');
      admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(info.lastInsertRowid);
    } catch (_) {
      admin = db.prepare('SELECT * FROM admins WHERE username = ?').get('owner_' + tgId);
    }
  }
  if (!admin) {
    admin = db.prepare('SELECT * FROM admins LIMIT 1').get();
  }
  if (!admin) return res.status(500).json({ error: 'Admin seed missing' });
  const token = signAdminToken(admin.id, admin.role || 'superadmin');
  res.json({
    token,
    admin: { id: admin.id, username: admin.username, role: admin.role || 'superadmin' },
    telegramId: tgId,
    fullPower: true
  });
});

router.get('/am-i-owner', requireAuth, (req, res) => {
  const tgId = String(req.user.telegram_id || '');
  res.json({ owner: isOwnerTelegramId(tgId), telegramId: tgId });
});

/**
 * GET /api/admin/stats
 */
router.get('/stats', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const totalBalance = db.prepare('SELECT COALESCE(SUM(balance + holding_balance), 0) as s FROM users').get().s;
  const totalMined = db.prepare('SELECT COALESCE(SUM(total_mined), 0) as s FROM users').get().s;
  const pendingWithdrawals = db.prepare("SELECT COUNT(*) as c FROM withdrawals WHERE status = 'pending'").get().c;
  const tasksCompleted = db.prepare("SELECT COUNT(*) as c FROM user_tasks WHERE status = 'claimed'").get().c;

  res.json({
    users,
    totalBalance: Number(totalBalance.toFixed(2)),
    totalMined: Number(totalMined.toFixed(2)),
    pendingWithdrawals,
    tasksCompleted
  });
});

/**
 * GET /api/admin/users
 */
router.get('/users', requireAdmin, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit = Math.min(100, parseInt(req.query.limit || '20', 10));
  const offset = (page - 1) * limit;
  const search = req.query.q || '';

  let users, total;
  if (search) {
    users = db.prepare(`
      SELECT id, telegram_id, username, first_name, balance, holding_balance, total_mined,
             miner_level, is_banned, is_verified, created_at
      FROM users
      WHERE username LIKE ? OR first_name LIKE ? OR telegram_id LIKE ?
      ORDER BY id DESC LIMIT ? OFFSET ?
    `).all(`%${search}%`, `%${search}%`, `%${search}%`, limit, offset);
    total = db.prepare(`
      SELECT COUNT(*) as c FROM users
      WHERE username LIKE ? OR first_name LIKE ? OR telegram_id LIKE ?
    `).get(`%${search}%`, `%${search}%`, `%${search}%`).c;
  } else {
    users = db.prepare(`
      SELECT id, telegram_id, username, first_name, balance, holding_balance, total_mined,
             miner_level, is_banned, is_verified, created_at
      FROM users ORDER BY id DESC LIMIT ? OFFSET ?
    `).all(limit, offset);
    total = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  }

  res.json({ users, total, page, limit });
});

/**
 * PATCH /api/admin/users/:id
 */
router.patch('/users/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { isBanned, balance, holdingBalance, totalMined } = req.body;

  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (typeof isBanned === 'boolean') {
    db.prepare('UPDATE users SET is_banned = ? WHERE id = ?').run(isBanned ? 1 : 0, id);
  }
  if (balance != null && balance !== '' && !Number.isNaN(Number(balance))) {
    db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(Number(balance), id);
  }
  if (holdingBalance != null && holdingBalance !== '' && !Number.isNaN(Number(holdingBalance))) {
    db.prepare('UPDATE users SET holding_balance = ? WHERE id = ?').run(Number(holdingBalance), id);
  }
  if (totalMined != null && totalMined !== '' && !Number.isNaN(Number(totalMined))) {
    db.prepare('UPDATE users SET total_mined = ? WHERE id = ?').run(Number(totalMined), id);
  }

  res.json({ success: true });
});

/**
 * GET/PUT /api/admin/settings
 */
router.get('/settings', requireAdmin, (req, res) => {
  res.json({ settings: getAllSettings() });
});

router.put('/settings', requireAdmin, (req, res) => {
  const allowed = [
    'mining_rate', 'mine_cooldown_seconds', 'energy_cost_per_mine',
    'energy_regen_per_hour', 'daily_mine_limit', 'referral_bonus',
    'referral_commission_pct', 'holding_unlock_pct_per_day', 'min_withdraw',
    'min_hype_swap', 'hype_to_ton_rate', 'hype_to_gram_rate',
    'min_usdt_deposit', 'usdt_deposit_address', 'usdt_deposit_network',
    'treasury_wallet', 'ton_verify_amount', 'ton_verify_enabled',
    'withdrawals_enabled', 'swap_enabled', 'deposit_enabled',
    'token_name', 'token_symbol', 'app_name', 'max_miner_level', 'hype_per_level', 'target_cap',
    'mining_pause_hours', 'mining_pause_notify_enabled',
    'community_channel_url', 'webapp_url'
  ];

  const updates = req.body || {};
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      setSetting(key, updates[key]);
    }
  }

  res.json({ success: true, settings: getAllSettings() });
});

/**
 * Tasks CRUD
 */
router.get('/tasks', requireAdmin, (req, res) => {
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY sort_order, id').all();
  res.json({ tasks });
});

router.post('/tasks', requireAdmin, (req, res) => {
  const { title, description, reward, type, targetUrl, channelId, sortOrder } = req.body;
  if (!title || reward == null) {
    return res.status(400).json({ error: 'title and reward required' });
  }
  const info = db.prepare(`
    INSERT INTO tasks (title, description, reward, type, target_url, channel_id, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(title, description || '', reward, type || 'manual', targetUrl || null, channelId || null, sortOrder || 0);

  res.json({ success: true, id: info.lastInsertRowid });
});

router.put('/tasks/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { title, description, reward, type, targetUrl, channelId, isActive, sortOrder } = req.body;
  const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  db.prepare(`
    UPDATE tasks SET
      title = COALESCE(?, title),
      description = COALESCE(?, description),
      reward = COALESCE(?, reward),
      type = COALESCE(?, type),
      target_url = COALESCE(?, target_url),
      channel_id = COALESCE(?, channel_id),
      is_active = COALESCE(?, is_active),
      sort_order = COALESCE(?, sort_order)
    WHERE id = ?
  `).run(title, description, reward, type, targetUrl, channelId, isActive != null ? (isActive ? 1 : 0) : null, sortOrder, id);

  res.json({ success: true });
});

router.delete('/tasks/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { getStore, saveStore } = require('../db');
  const store = getStore();
  const before = (store.tasks || []).length;
  store.tasks = (store.tasks || []).filter(t => t.id !== id);
  if (store.tasks.length === before) {
    return res.status(404).json({ error: 'Task not found' });
  }
  saveStore();
  res.json({ success: true });
});

/** Test DIGGO-style message with Open + Join Community buttons */
router.post('/notify-test', requireAdmin, async (req, res) => {
  const {
    sendBotMessage,
    buildMiningPauseKeyboard,
    buildPauseText,
    getBotLinks
  } = require('../utils/telegram');
  const { getSetting } = require('../db');
  const telegramId = String(req.body.telegramId || req.body.chatId || '').trim();
  if (!telegramId) {
    return res.status(400).json({ error: 'telegramId required' });
  }
  const hours = parseFloat(getSetting('mining_pause_hours', '8')) || 8;
  const text = buildPauseText(hours, getSetting('app_name', 'HYPE MINER'));
  const keyboard = buildMiningPauseKeyboard();
  const links = getBotLinks();
  const result = await sendBotMessage(telegramId, text, keyboard);
  res.json({
    success: !!(result && result.ok),
    telegram: result,
    links,
    tip: !links.webappUrl
      ? 'Set WEBAPP_URL on Render (https://your-app.onrender.com) and community_channel_url in HQ Settings'
      : 'OK'
  });
});

/** Force run 8h pause job now */
router.post('/notify-run', requireAdmin, async (req, res) => {
  try {
    const { runMiningPauseNotify } = require('../jobs/miningPauseNotify');
    const result = await runMiningPauseNotify();
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Withdrawals management
 */
router.get('/withdrawals', requireAdmin, (req, res) => {
  const status = req.query.status || 'pending';
  const rows = db.prepare(`
    SELECT w.*, u.username, u.telegram_id, u.first_name
    FROM withdrawals w
    JOIN users u ON u.id = w.user_id
    WHERE w.status = ?
    ORDER BY w.created_at DESC
    LIMIT 100
  `).all(status);
  res.json({ withdrawals: rows });
});

router.patch('/withdrawals/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status, txHash, adminNote } = req.body;
  const allowed = ['pending', 'processing', 'completed', 'rejected'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  db.prepare(`
    UPDATE withdrawals SET status = ?, tx_hash = ?, admin_note = ?, processed_at = datetime('now')
    WHERE id = ?
  `).run(status, txHash || null, adminNote || null, id);

  // If rejected, refund
  if (status === 'rejected') {
    const w = db.prepare('SELECT user_id, amount FROM withdrawals WHERE id = ?').get(id);
    if (w) {
      db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(w.amount, w.user_id);
    }
  }

  res.json({ success: true });
});



/**
 * GET /api/admin/deposits
 */
router.get('/deposits', requireAdmin, (req, res) => {
  const { getStore } = require('../db');
  const status = req.query.status || 'pending';
  const store = getStore();
  const rows = (store.deposits || [])
    .filter(d => !status || status === 'all' || d.status === status)
    .map(d => {
      const u = store.users.find(x => x.id === d.user_id) || {};
      return { ...d, username: u.username, telegram_id: u.telegram_id, first_name: u.first_name };
    })
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .slice(0, 100);
  res.json({ deposits: rows });
});

/**
 * PATCH /api/admin/deposits/:id
 * Confirm or reject deposit.
 * - USDT (purpose withdraw_unlock): credit usdt + unlock withdraw
 * - TON  (purpose verify): mark user is_verified
 */
router.patch('/deposits/:id', requireAdmin, (req, res) => {
  const { getStore, saveStore } = require('../db');
  const id = parseInt(req.params.id, 10);
  const { status, adminNote } = req.body;
  if (!['confirmed', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'status must be confirmed or rejected' });
  }

  const store = getStore();
  const dep = (store.deposits || []).find(d => d.id === id);
  if (!dep) return res.status(404).json({ error: 'Deposit not found' });
  if (dep.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

  dep.status = status;
  dep.admin_note = adminNote || null;
  dep.confirmed_at = new Date().toISOString();

  if (status === 'confirmed') {
    const u = store.users.find(x => x.id === dep.user_id);
    if (u) {
      const asset = (dep.asset || 'USDT').toUpperCase();
      const purpose = dep.purpose || (asset === 'TON' ? 'verify' : 'withdraw_unlock');
      if (asset === 'TON' || purpose === 'verify') {
        u.is_verified = 1;
      } else {
        u.usdt_credited = Number(((u.usdt_credited || 0) + dep.amount).toFixed(4));
        u.withdraw_unlocked = 1;
      }
      u.updated_at = new Date().toISOString();
    }
  }

  saveStore();
  res.json({ success: true, deposit: dep });
});

module.exports = router;
