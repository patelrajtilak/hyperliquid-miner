/**
 * HYPE MINER Database Layer – pure Node.js JSON file store + Cloudflare KV
 *
 * CRITICAL (Render / free hosting):
 * - Local disk is EPHEMERAL unless you mount a Persistent Disk.
 * - Set DB_PATH to the disk mount, e.g. /data/hype.json on Render.
 * - We load ONCE into memory and never re-read on every request (that was wiping live state).
 * - Saves are atomic (temp + rename) + .bak backup.
 *
 * Cloudflare Workers:
 * - No real filesystem / __dirname may be undefined.
 * - Persistence uses KV binding HYPE_DB (set via setKvBinding from cf-worker.js).
 * - FS path resolution is skipped / uses safe dummies when CLOUDFLARE or no __dirname.
 */
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

// Cloudflare KV binding (set via setKvBinding from cf-worker)
let kvBinding = null;
const KV_KEY = 'hype_store_v1';

function setKvBinding(kv) {
  kvBinding = kv;
  console.log('[db] KV binding attached');
}

function isCloudflareRuntime() {
  return !!(
    process.env.CLOUDFLARE ||
    process.env.CF_PAGES ||
    process.env.CF_WORKER ||
    kvBinding
  );
}

/**
 * Resolve local filesystem paths for Node / Render / Railway.
 * On Cloudflare Workers (__dirname missing or CLOUDFLARE set) return safe
 * dummy paths — FS writes are ignored when kvBinding is present.
 */
function resolveDbPaths() {
  // Explicit env wins (Node hosts with Persistent Disk)
  if (process.env.DB_PATH) {
    const file = process.env.DB_PATH;
    return { dir: path.dirname(file), file };
  }

  // Cloudflare Workers: no usable local FS, avoid __dirname entirely
  if (typeof __dirname === 'undefined' || isCloudflareRuntime()) {
    return { dir: '/tmp', file: '/tmp/hype.json' };
  }

  // Common persistent mounts (Render Disk, Railway volume, Docker /data)
  const candidates = [
    '/data',
    '/var/data',
    path.join(__dirname, '..', 'data')
  ];
  let dir = candidates[candidates.length - 1];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        fs.accessSync(c, fs.constants.W_OK);
        dir = c;
        break;
      }
    } catch (_) {}
  }
  // Ensure dir exists (Node only)
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.warn('Could not create data dir', dir, e.message);
    try {
      dir = path.join(__dirname, '..', 'data');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (e2) {
      dir = '/tmp';
    }
  }
  return { dir, file: path.join(dir, 'hype.json') };
}

// Safe top-level init — never throws on missing __dirname
let DATA_DIR = '/tmp';
let DB_FILE = '/tmp/hype.json';
let DB_BAK = '/tmp/hype.json.bak';
try {
  const resolved = resolveDbPaths();
  DATA_DIR = resolved.dir;
  DB_FILE = resolved.file;
  DB_BAK = DB_FILE + '.bak';
} catch (e) {
  console.warn('[db] path resolve fallback:', e && e.message);
}
if (!isCloudflareRuntime()) {
  console.log('[db] using file:', DB_FILE);
} else {
  console.log('[db] Cloudflare mode — persistence via HYPE_DB KV');
}

const EMPTY_STORE = () => ({
  users: [],
  settings: {},
  tasks: [],
  user_tasks: [],
  mining_log: [],
  referrals: [],
  withdrawals: [],
  deposits: [],
  swaps: [],
  admins: [],
  activity_log: [],
  payment_channels: [],
  _seq: { users: 1, tasks: 1, user_tasks: 1, mining_log: 1, referrals: 1, withdrawals: 1, deposits: 1, swaps: 1, admins: 1, activity_log: 1, payment_channels: 1 }
});

let store = EMPTY_STORE();
let loadedOnce = false;
/** true only after a successful KV read that returned data (or confirmed empty). Prevents empty-store wipe. */
let kvHydrated = false;
let saveTimer = null;
let dirty = false;
/** Pending KV put promises — CF worker must waitUntil these or writes are lost. */
let pendingPuts = [];
let lastSavedUserCount = -1;

function readJsonFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw || !raw.trim()) throw new Error('empty file');
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object') throw new Error('invalid store');
  if (!Array.isArray(data.users)) data.users = [];
  if (!data.settings || typeof data.settings !== 'object') data.settings = {};
  if (!Array.isArray(data.tasks)) data.tasks = [];
  if (!data._seq) data._seq = {};
  return data;
}

function load() {
  // Only load from disk ONCE — never clobber in-memory state mid-request
  if (loadedOnce) return;
  // On Cloudflare, loadFromKv() is the source of truth (called at boot)
  if (isCloudflareRuntime() && kvBinding) {
    loadedOnce = true;
    return;
  }
  try {
    if (fs.existsSync(DB_FILE)) {
      store = readJsonFile(DB_FILE);
      console.log('[db] loaded', DB_FILE, 'users=', store.users.length, 'tasks=', store.tasks.length);
    } else if (fs.existsSync(DB_BAK)) {
      store = readJsonFile(DB_BAK);
      console.log('[db] recovered from backup', DB_BAK, 'users=', store.users.length);
      // restore primary file
      saveNow();
    } else {
      console.log('[db] no existing file — fresh store at', DB_FILE);
    }
  } catch (e) {
    console.warn('[db] primary load failed:', e.message);
    try {
      if (fs.existsSync(DB_BAK)) {
        store = readJsonFile(DB_BAK);
        console.log('[db] recovered from .bak after error');
      }
    } catch (e2) {
      console.warn('[db] backup load failed, starting empty:', e2.message);
      store = EMPTY_STORE();
    }
  }
  loadedOnce = true;
}

function saveNow() {
  try {
    const json = JSON.stringify(store, null, 2);
    const userCount = (store.users && store.users.length) || 0;

    // File system path (Node / Render / local) — skip entirely on CF
    if (!isCloudflareRuntime()) {
      try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        const tmp = DB_FILE + '.tmp';
        fs.writeFileSync(tmp, json, 'utf8');
        try {
          if (fs.existsSync(DB_FILE)) {
            fs.copyFileSync(DB_FILE, DB_BAK);
          }
        } catch (_) {}
        try {
          fs.renameSync(tmp, DB_FILE);
        } catch (_) {
          fs.writeFileSync(DB_FILE, json, 'utf8');
          try { fs.unlinkSync(tmp); } catch (_) {}
        }
      } catch (fsErr) {
        if (!kvBinding) console.error('[db] SAVE FAILED (fs):', fsErr.message);
      }
    }

    // Cloudflare KV — MUST be awaited via ctx.waitUntil(flushPending()) or write is lost
    if (kvBinding) {
      try {
        // HARD GUARD: never wipe existing data with empty users
        if (userCount === 0 && !kvHydrated) {
          console.error('[db] REFUSING KV put of empty store — KV not hydrated (protects users)');
        } else if (userCount === 0 && lastSavedUserCount > 0) {
          console.error('[db] REFUSING KV put that would wipe', lastSavedUserCount, 'users → 0');
        } else {
          const p = Promise.resolve(kvBinding.put(KV_KEY, json))
            .then(() => {
              lastSavedUserCount = userCount;
              console.log('[db] KV put OK, users=', userCount, 'bytes=', json.length);
            })
            .catch(e => console.error('[db] KV put failed', e && e.message ? e.message : e));
          pendingPuts.push(p);
          // Cap queue so memory does not grow forever
          if (pendingPuts.length > 20) pendingPuts = pendingPuts.slice(-10);
        }
      } catch (e) {
        console.error('[db] KV save error', e.message);
      }
    }
    dirty = false;
  } catch (e) {
    console.error('[db] SAVE FAILED — data may be lost on restart:', e.message);
  }
}

/** Await all pending KV writes. Call from CF worker: ctx.waitUntil(db.flushPending()) */
async function flushPending() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (dirty) saveNow();
  }
  const batch = pendingPuts.slice();
  pendingPuts = [];
  if (!batch.length) return { flushed: 0 };
  try {
    await Promise.all(batch);
    return { flushed: batch.length };
  } catch (e) {
    console.error('[db] flushPending error', e && e.message);
    return { flushed: 0, error: String(e && e.message) };
  }
}

/** Async load from KV (call once at CF boot). Returns true if data was found. */
async function loadFromKv() {
  if (!kvBinding) return false;
  try {
    const raw = await kvBinding.get(KV_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && typeof data === 'object' && Array.isArray(data.users)) {
        store = data;
        loadedOnce = true;
        kvHydrated = true;
        lastSavedUserCount = store.users.length;
        console.log('[db] loaded from KV, users=', store.users.length, 'referrals=', (store.referrals || []).length);
        return true;
      }
      console.warn('[db] KV key present but invalid shape — keeping empty in-memory, will NOT overwrite KV');
      loadedOnce = true;
      // kvHydrated stays false so we refuse to put empty over existing blob
      return false;
    }
    // Key missing = truly fresh namespace
    loadedOnce = true;
    kvHydrated = true; // confirmed empty — OK to write later
    console.log('[db] KV empty (no key) — fresh install');
    return false;
  } catch (e) {
    console.warn('[db] KV load failed (will NOT save empty over existing data):', e.message);
    loadedOnce = true;
    // kvHydrated false → saveNow will refuse KV put of empty store
    return false;
  }
}

function save() {
  dirty = true;
  // Debounce rapid writes, always flush within 300ms
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 50);
}

// Flush on exit (Node only — Workers have no process signals the same way)
function flushSync() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (dirty || true) saveNow();
}
try {
  if (typeof process !== 'undefined' && process.on && !isCloudflareRuntime()) {
    process.on('SIGINT', () => { flushSync(); process.exit(0); });
    process.on('SIGTERM', () => { flushSync(); process.exit(0); });
    process.on('beforeExit', () => { flushSync(); });
  }
} catch (_) {}

// Periodic safety flush every 20s
try {
  const iv = setInterval(() => {
    if (dirty) saveNow();
  }, 20 * 1000);
  if (iv && typeof iv.unref === 'function') iv.unref();
} catch (_) {}

function nextId(table) {
  const id = store._seq[table] || 1;
  store._seq[table] = id + 1;
  return id;
}

const DEFAULTS = {
  mining_rate: '1.25',
  mine_cooldown_seconds: '30',
  energy_cost_per_mine: '5',
  energy_regen_per_hour: '20',
  daily_mine_limit: '50',
  referral_bonus: '25',
  referral_commission_pct: '5',
  holding_unlock_pct_per_day: '5',
  min_withdraw: '1',
  min_hype_swap: '1',
  hype_to_ton_rate: '0.01',
  hype_to_gram_rate: '0.5',
  min_usdt_deposit: '0.5',
  withdraw_fee_amount: '0.5',
  withdraw_fee_asset: 'USDT',
  withdraw_fee_enabled: 'true',
  usdt_deposit_address: '',
  usdt_deposit_network: 'BEP20',
  treasury_wallet: '',
  // Wallet verification fee (TON network)
  ton_verify_amount: '0.1',
  ton_verify_enabled: 'true',
  market_api_url: '',
  token_name: 'HYPE',
  token_symbol: 'HYPE',
  app_name: 'HYPE MINER',
  withdrawals_enabled: 'false',
  swap_enabled: 'true',
  deposit_enabled: 'true',
  target_cap: '2000000',
  max_miner_level: '1000',
  hype_per_level: '10',
  xp_per_mine: '10',
  // DIGGO-style inactivity reminder
  mining_pause_hours: '8',
  mining_pause_notify_enabled: 'true',
  community_channel_url: 'https://t.me/HypeMinerOfficial',
  webapp_url: ''
};

function migrate() {
  load();
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (store.settings[k] === undefined) store.settings[k] = v;
  }
  store.deposits = store.deposits || [];
  store.payment_channels = store.payment_channels || [];
  store.swaps = store.swaps || [];
  store._seq = store._seq || {};
  ['users','tasks','user_tasks','mining_log','referrals','withdrawals','deposits','swaps','admins','activity_log'].forEach(k => {
    if (!store._seq[k]) store._seq[k] = 1;
  });
  (store.users || []).forEach(u => {
    if (u.ton_balance == null) u.ton_balance = 0;
    if (u.gram_balance == null) u.gram_balance = 0;
    if (u.usdt_credited == null) u.usdt_credited = 0;
    if (u.withdraw_unlocked == null) u.withdraw_unlocked = 0;
    if (u.mining_pause_notified_at === undefined) u.mining_pause_notified_at = null;
    if (u.withdraw_fee_paid == null) u.withdraw_fee_paid = !!u.withdraw_unlocked ? 1 : 0;
  });
  // Only persist if we have real data or confirmed empty KV (never wipe on failed load)
  if (kvHydrated || (store.users && store.users.length > 0) || !kvBinding) {
    save();
  } else {
    console.warn('[db] migrate skipped save — KV not hydrated, protecting existing data');
  }
  console.log('Migration / settings ensured. users=', (store.users || []).length);
}

function seed() {
  load();
  if (store.admins.length === 0) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10);
    store.admins.push({
      id: nextId('admins'),
      username: process.env.ADMIN_USERNAME || 'admin',
      password_hash: hash,
      role: 'superadmin',
      created_at: new Date().toISOString()
    });
    console.log('Default admin created.');
  }
  // Seed sample tasks ONLY on completely fresh install — never re-add after admin edits
  if (store.tasks.length === 0 && store.users.length === 0) {
    const samples = [
      { title: 'Join HYPE Official Channel', description: 'Join our official Telegram channel', reward: 2.1, type: 'channel', target_url: 'https://t.me/HypeMinerOfficial', channel_id: '@HypeMinerOfficial', sort_order: 1 },
      { title: 'Subscribe HYPE on YouTube', description: 'Subscribe to our official YouTube channel', reward: 3.0, type: 'youtube', target_url: 'https://www.youtube.com/@HypeMiner', channel_id: null, sort_order: 2 },
      { title: 'Follow HYPE on X (Twitter)', description: 'Follow our official X account', reward: 2.1, type: 'twitter', target_url: 'https://x.com/HypeMiner', channel_id: null, sort_order: 3 }
    ];
    for (const t of samples) {
      store.tasks.push({
        id: nextId('tasks'),
        ...t,
        is_active: 1,
        max_completions: 0,
        created_at: new Date().toISOString()
      });
    }
    console.log('Sample tasks seeded (fresh install only).');
  }
  if (kvHydrated || (store.users && store.users.length > 0) || (store.admins && store.admins.length > 0) || !kvBinding) {
    saveNow();
  } else {
    console.warn('[db] seed skipped save — KV not hydrated');
  }
}

function getSetting(key, fallback = null) {
  return store.settings[key] !== undefined ? store.settings[key] : fallback;
}

function setSetting(key, value) {
  store.settings[key] = String(value);
  save();
}

function getAllSettings() {
  return { ...store.settings };
}

function transaction(fn) {
  const snapshot = JSON.stringify(store);
  try {
    const result = fn();
    save();
    return result;
  } catch (e) {
    store = JSON.parse(snapshot);
    throw e;
  }
}

const db = {
  prepare(sql) {
    return {
      get(...params) { return runQuery(sql, params, 'get'); },
      all(...params) { return runQuery(sql, params, 'all'); },
      run(...params) { return runQuery(sql, params, 'run'); }
    };
  },
  transaction(fn) { return () => transaction(fn); },
  exec() {}
};

function runQuery(sql, params, mode) {
  const s = sql.replace(/\s+/g, ' ').trim();
  // DO NOT reload from disk here — memory is source of truth after boot

  if (/SELECT \* FROM users WHERE telegram_id = \?/i.test(s)) {
    const u = store.users.find(x => x.telegram_id === String(params[0]));
    return mode === 'get' ? u || undefined : (u ? [u] : []);
  }
  if (/SELECT \* FROM users WHERE id = \?/i.test(s)) {
    const u = store.users.find(x => x.id === params[0]);
    return mode === 'get' ? u || undefined : (u ? [u] : []);
  }
  if (/SELECT id FROM users WHERE referral_code = \?/i.test(s)) {
    const u = store.users.find(x => x.referral_code === String(params[0]).toUpperCase());
    return mode === 'get' ? (u ? { id: u.id } : undefined) : [];
  }
  if (/SELECT COUNT\(\*\) as c FROM admins/i.test(s)) return { c: store.admins.length };
  if (/SELECT COUNT\(\*\) as c FROM tasks/i.test(s)) return { c: store.tasks.length };
  if (/SELECT COUNT\(\*\) as c FROM users/i.test(s) && !/WHERE/i.test(s)) return { c: store.users.length };
  if (/SELECT COUNT\(\*\) as c FROM referrals WHERE referrer_id = \?/i.test(s)) {
    return { c: store.referrals.filter(r => r.referrer_id === params[0]).length };
  }
  if (/SELECT id FROM referrals WHERE referred_id = \?/i.test(s)) {
    const r = store.referrals.find(x => x.referred_id === params[0]);
    return r ? { id: r.id } : undefined;
  }
  if (/SELECT COALESCE\(SUM\(balance \+ holding_balance\), 0\) as s FROM users/i.test(s)) {
    return { s: store.users.reduce((a, u) => a + (u.balance || 0) + (u.holding_balance || 0), 0) };
  }
  if (/SELECT id, username, first_name, photo_url, miner_level, total_mined, balance, holding_balance\s+FROM users/i.test(s) && /ORDER BY total_mined DESC/i.test(s)) {
    const limit = params[0] != null ? params[0] : 100;
    return store.users
      .filter(u => !u.is_banned)
      .sort((a, b) => {
        const tm = (Number(b.total_mined) || 0) - (Number(a.total_mined) || 0);
        if (tm !== 0) return tm;
        return (Number(b.balance) || 0) - (Number(a.balance) || 0);
      })
      .slice(0, limit)
      .map(u => ({
        id: u.id,
        username: u.username,
        first_name: u.first_name,
        photo_url: u.photo_url,
        miner_level: u.miner_level,
        total_mined: u.total_mined || 0,
        balance: u.balance || 0,
        holding_balance: u.holding_balance || 0
      }));
  }
  if (/SELECT id, total_mined, balance\s+FROM users/i.test(s) && /ORDER BY total_mined DESC/i.test(s)) {
    return store.users
      .filter(u => !u.is_banned)
      .sort((a, b) => {
        const tm = (Number(b.total_mined) || 0) - (Number(a.total_mined) || 0);
        if (tm !== 0) return tm;
        return (Number(b.balance) || 0) - (Number(a.balance) || 0);
      })
      .map(u => ({ id: u.id, total_mined: u.total_mined || 0, balance: u.balance || 0 }));
  }
  if (/SELECT COALESCE\(SUM\(total_mined\), 0\) as s FROM users/i.test(s)) {
    return { s: store.users.reduce((a, u) => a + (u.total_mined || 0), 0) };
  }
  if (/SELECT COUNT\(\*\) as c FROM withdrawals WHERE status = 'pending'/i.test(s)) {
    return { c: store.withdrawals.filter(w => w.status === 'pending').length };
  }
  if (/SELECT COUNT\(\*\) as c FROM user_tasks WHERE status = 'claimed'/i.test(s)) {
    return { c: store.user_tasks.filter(t => t.status === 'claimed').length };
  }
  if (/SELECT value FROM settings WHERE key = \?/i.test(s)) {
    const v = store.settings[params[0]];
    return v !== undefined ? { value: v } : undefined;
  }
  if (/SELECT key, value FROM settings/i.test(s)) {
    return Object.entries(store.settings).map(([key, value]) => ({ key, value }));
  }
  if (/SELECT \* FROM admins WHERE username = \?/i.test(s)) {
    return store.admins.find(a => a.username === params[0]);
  }
  if (/SELECT \* FROM admins WHERE id = \?/i.test(s)) {
    return store.admins.find(a => a.id === params[0]);
  }
  if (/SELECT \* FROM admins LIMIT 1/i.test(s)) {
    return store.admins[0];
  }
  if (/SELECT id, username, role FROM admins WHERE id = \?/i.test(s)) {
    const a = store.admins.find(x => x.id === params[0]);
    return a ? { id: a.id, username: a.username, role: a.role } : undefined;
  }
  if (/SELECT \* FROM tasks WHERE id = \? AND is_active = 1/i.test(s)) {
    return store.tasks.find(t => t.id === params[0] && t.is_active);
  }
  if (/SELECT \* FROM tasks WHERE id = \?/i.test(s)) {
    return store.tasks.find(t => t.id === params[0]);
  }
  if (/SELECT \* FROM tasks ORDER BY sort_order/i.test(s)) {
    return [...store.tasks].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  }
  if (/SELECT t\.\*, ut\.status as user_status/i.test(s)) {
    const userId = params[0];
    return store.tasks.filter(t => t.is_active).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)).map(t => {
      const ut = store.user_tasks.find(x => x.user_id === userId && x.task_id === t.id);
      return { ...t, user_status: ut?.status || null, claimed_at: ut?.claimed_at || null };
    });
  }
  if (/SELECT \* FROM user_tasks WHERE user_id = \? AND task_id = \?/i.test(s)) {
    return store.user_tasks.find(x => x.user_id === params[0] && x.task_id === params[1]);
  }
  if (/SELECT amount, created_at FROM mining_log WHERE user_id = \?/i.test(s)) {
    return store.mining_log.filter(m => m.user_id === params[0]).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 20).map(m => ({ amount: m.amount, created_at: m.created_at }));
  }
  if (/SELECT t\.title, ut\.claimed_at, t\.reward FROM user_tasks/i.test(s)) {
    return store.user_tasks.filter(ut => ut.user_id === params[0] && ut.status === 'claimed').sort((a, b) => (b.claimed_at || '').localeCompare(a.claimed_at || '')).slice(0, 10).map(ut => {
      const t = store.tasks.find(x => x.id === ut.task_id);
      return { title: t?.title, claimed_at: ut.claimed_at, reward: t?.reward };
    });
  }
  if (/SELECT u\.id, u\.username.*FROM referrals r/i.test(s)) {
    return store.referrals.filter(r => r.referrer_id === params[0]).map(r => {
      const u = store.users.find(x => x.id === r.referred_id) || {};
      return { id: u.id, username: u.username, first_name: u.first_name, miner_level: u.miner_level, total_mined: u.total_mined, created_at: r.created_at, commission_earned: r.commission_earned || 0 };
    }).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  }
  if (/SELECT COUNT\(\*\) as count, COALESCE\(SUM\(commission_earned\)/i.test(s)) {
    const refs = store.referrals.filter(r => r.referrer_id === params[0]);
    return { count: refs.length, total_commission: refs.reduce((a, r) => a + (r.commission_earned || 0), 0) };
  }
  if (/SELECT id, amount, wallet_address, status, tx_hash/i.test(s) && /withdrawals WHERE user_id/i.test(s)) {
    return store.withdrawals.filter(w => w.user_id === params[0]).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 50);
  }
  if (/SELECT w\.\*, u\.username.*FROM withdrawals w/i.test(s)) {
    return store.withdrawals.filter(w => w.status === params[0]).map(w => {
      const u = store.users.find(x => x.id === w.user_id) || {};
      return { ...w, username: u.username, telegram_id: u.telegram_id, first_name: u.first_name };
    }).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 100);
  }
  if (/SELECT id, telegram_id, username.*FROM users/i.test(s)) {
    let list = [...store.users].sort((a, b) => b.id - a.id);
    const limit = params[params.length - 2] || 20;
    const offset = params[params.length - 1] || 0;
    return list.slice(offset, offset + limit).map(u => ({
      id: u.id, telegram_id: u.telegram_id, username: u.username, first_name: u.first_name,
      balance: u.balance, holding_balance: u.holding_balance, total_mined: u.total_mined,
      miner_level: u.miner_level, is_banned: u.is_banned, is_verified: u.is_verified, created_at: u.created_at
    }));
  }
  if (/SELECT balance FROM users WHERE id = \?/i.test(s)) {
    const u = store.users.find(x => x.id === params[0]);
    return u ? { balance: u.balance } : undefined;
  }
  if (/SELECT user_id, amount FROM withdrawals WHERE id = \?/i.test(s)) {
    const w = store.withdrawals.find(x => x.id === params[0]);
    return w ? { user_id: w.user_id, amount: w.amount } : undefined;
  }
  if (/SELECT id FROM users WHERE id = \?/i.test(s)) {
    const u = store.users.find(x => x.id === params[0]);
    return u ? { id: u.id } : undefined;
  }
  if (/SELECT id FROM tasks WHERE id = \?/i.test(s)) {
    const t = store.tasks.find(x => x.id === params[0]);
    return t ? { id: t.id } : undefined;
  }

  // INSERTS
  if (/INSERT INTO users \(/i.test(s)) {
    const id = nextId('users');
    store.users.push({
      id, telegram_id: params[0], username: params[1], first_name: params[2], last_name: params[3],
      photo_url: params[4], referral_code: params[5], referred_by: params[6], energy: params[7], max_energy: params[8],
      balance: 0, holding_balance: 0, ton_balance: 0, gram_balance: 0, usdt_credited: 0, withdraw_unlocked: 0,
      last_mine_at: null, last_energy_regen: null, daily_mined: 0,
      daily_reset_at: new Date().toISOString(), wallet_address: null, is_verified: 0, is_banned: 0,
      miner_level: 1, total_mined: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    });
    save();
    return { lastInsertRowid: id, changes: 1 };
  }
  if (/INSERT INTO referrals/i.test(s)) {
    // SQL may be: VALUES (?, ?, 1) → only 2 params; or VALUES (?, ?, ?) → 3 params
    const bonusPaid = params.length >= 3 ? (Number(params[2]) || 0) : 1;
    store.referrals.push({
      id: nextId('referrals'),
      referrer_id: params[0],
      referred_id: params[1],
      bonus_paid: bonusPaid,
      commission_earned: 0,
      created_at: new Date().toISOString()
    });
    save(); return { changes: 1, lastInsertRowid: store.referrals[store.referrals.length - 1].id };
  }
  if (/INSERT INTO activity_log/i.test(s)) {
    store.activity_log.push({ id: nextId('activity_log'), user_id: params[0], action: params[1], details: params[2], created_at: new Date().toISOString() });
    save(); return { changes: 1 };
  }
  if (/INSERT INTO mining_log/i.test(s)) {
    store.mining_log.push({ id: nextId('mining_log'), user_id: params[0], amount: params[1], energy_used: params[2], created_at: new Date().toISOString() });
    save(); return { changes: 1 };
  }
  if (/INSERT INTO user_tasks/i.test(s)) {
    store.user_tasks.push({ id: nextId('user_tasks'), user_id: params[0], task_id: params[1], status: params[2] || 'completed', completed_at: new Date().toISOString(), claimed_at: null });
    save(); return { changes: 1 };
  }
  if (/INSERT INTO tasks/i.test(s)) {
    const id = nextId('tasks');
    store.tasks.push({ id, title: params[0], description: params[1], reward: params[2], type: params[3], target_url: params[4], channel_id: params[5], sort_order: params[6] || 0, is_active: 1, max_completions: 0, created_at: new Date().toISOString() });
    save(); return { lastInsertRowid: id, changes: 1 };
  }
  if (/INSERT INTO withdrawals/i.test(s)) {
    const id = nextId('withdrawals');
    store.withdrawals.push({ id, user_id: params[0], amount: params[1], wallet_address: params[2], status: params[3] || 'pending', tx_hash: null, admin_note: null, created_at: new Date().toISOString(), processed_at: null });
    save(); return { lastInsertRowid: id, changes: 1 };
  }
  if (/INSERT INTO admins/i.test(s)) {
    const id = nextId('admins');
    store.admins.push({ id, username: params[0], password_hash: params[1], role: params[2], created_at: new Date().toISOString() });
    save(); return { lastInsertRowid: id, changes: 1 };
  }

  // UPDATES
  if (/UPDATE users SET holding_balance = holding_balance \+ \? WHERE id = \?/i.test(s)) {
    const u = store.users.find(x => x.id === params[1]);
    if (u) { u.holding_balance = (u.holding_balance || 0) + params[0]; save(); return { changes: 1 }; }
    return { changes: 0 };
  }
  if (/UPDATE users SET balance = balance \+ \? WHERE id = \?/i.test(s) && params.length === 2) {
    const u = store.users.find(x => x.id === params[1]);
    if (u) { u.balance = (u.balance || 0) + params[0]; save(); return { changes: 1 }; }
    return { changes: 0 };
  }
  if (/UPDATE users SET balance = balance \+ \?, total_mined = total_mined \+ \?/i.test(s)) {
    const u = store.users.find(x => x.id === params[2]);
    if (u) { u.balance = (u.balance || 0) + params[0]; u.total_mined = (u.total_mined || 0) + params[1]; u.updated_at = new Date().toISOString(); save(); return { changes: 1 }; }
    return { changes: 0 };
  }
  if (/UPDATE users SET balance = balance - \? WHERE id = \? AND balance >= \?/i.test(s)) {
    const u = store.users.find(x => x.id === params[1]);
    if (u && u.balance >= params[2]) { u.balance -= params[0]; save(); return { changes: 1 }; }
    return { changes: 0 };
  }
  if (/UPDATE users SET energy = \?, last_energy_regen/i.test(s)) {
    const u = store.users.find(x => x.id === params[1]);
    if (u) { u.energy = params[0]; u.last_energy_regen = new Date().toISOString(); save(); return { changes: 1 }; }
    return { changes: 0 };
  }
  if (/UPDATE users SET daily_mined = 0, daily_reset_at/i.test(s)) {
    const u = store.users.find(x => x.id === params[0]);
    if (u) { u.daily_mined = 0; u.daily_reset_at = new Date().toISOString(); save(); return { changes: 1 }; }
    return { changes: 0 };
  }
  if (/UPDATE users SET balance = \?, energy = \?, last_mine_at/i.test(s)) {
    const u = store.users.find(x => x.id === params[5]);
    if (u) {
      u.balance = params[0]; u.energy = params[1]; u.last_mine_at = new Date().toISOString();
      u.daily_mined = params[2]; u.total_mined = params[3]; u.miner_level = params[4];
      // re-arm pause reminder after they mine again
      u.mining_pause_notified_at = null;
      u.updated_at = new Date().toISOString(); save(); return { changes: 1 };
    }
    return { changes: 0 };
  }
  if (/UPDATE users SET balance = \?, holding_balance = \?/i.test(s)) {
    const u = store.users.find(x => x.id === params[2]);
    if (u) { u.balance = params[0]; u.holding_balance = params[1]; u.updated_at = new Date().toISOString(); save(); return { changes: 1 }; }
    return { changes: 0 };
  }
  if (/UPDATE users SET referred_by = \? WHERE id = \?/i.test(s)) {
    const u = store.users.find(x => x.id === params[1]);
    if (u) { u.referred_by = params[0]; u.updated_at = new Date().toISOString(); save(); return { changes: 1 }; }
    return { changes: 0 };
  }
  if (/UPDATE users SET username = \?, first_name/i.test(s)) {
    const u = store.users.find(x => x.id === params[4]);
    if (u) { u.username = params[0]; u.first_name = params[1]; u.last_name = params[2]; u.photo_url = params[3]; u.updated_at = new Date().toISOString(); save(); return { changes: 1 }; }
    return { changes: 0 };
  }
  if (/UPDATE users SET wallet_address = \?, is_verified = 1/i.test(s)) {
    const u = store.users.find(x => x.id === params[1]);
    if (u) { u.wallet_address = params[0]; u.is_verified = 1; u.updated_at = new Date().toISOString(); save(); return { changes: 1 }; }
    return { changes: 0 };
  }
  if (/UPDATE users SET wallet_address = \?, updated_at/i.test(s)) {
    const u = store.users.find(x => x.id === params[1]);
    if (u) { u.wallet_address = params[0]; u.updated_at = new Date().toISOString(); save(); return { changes: 1 }; }
    return { changes: 0 };
  }
  if (/UPDATE users SET is_banned = \?/i.test(s)) {
    const u = store.users.find(x => x.id === params[1]);
    if (u) { u.is_banned = params[0]; save(); return { changes: 1 }; }
    return { changes: 0 };
  }
  if (/UPDATE users SET total_mined = \? WHERE id = \?/i.test(s)) {
    const u = store.users.find(x => x.id === params[1]);
    if (u) { u.total_mined = Number(params[0]) || 0; u.updated_at = new Date().toISOString(); save(); return { changes: 1 }; }
    return { changes: 0 };
  }
  if (/UPDATE users SET balance = \? WHERE id = \?/i.test(s) && params.length === 2) {
    const u = store.users.find(x => x.id === params[1]);
    if (u) { u.balance = params[0]; save(); return { changes: 1 }; }
    return { changes: 0 };
  }
  if (/UPDATE users SET holding_balance = \? WHERE id = \?/i.test(s)) {
    const u = store.users.find(x => x.id === params[1]);
    if (u) { u.holding_balance = params[0]; save(); return { changes: 1 }; }
    return { changes: 0 };
  }
  if (/UPDATE user_tasks SET status = 'completed'/i.test(s)) {
    const ut = store.user_tasks.find(x => x.id === params[0]);
    if (ut) { ut.status = 'completed'; ut.completed_at = new Date().toISOString(); save(); return { changes: 1 }; }
    return { changes: 0 };
  }
  if (/UPDATE user_tasks SET status = 'claimed'/i.test(s)) {
    const ut = store.user_tasks.find(x => x.id === params[0]);
    if (ut) { ut.status = 'claimed'; ut.claimed_at = new Date().toISOString(); save(); return { changes: 1 }; }
    return { changes: 0 };
  }
  if (/UPDATE referrals SET commission_earned = commission_earned \+ \?/i.test(s)) {
    const r = store.referrals.find(x => x.referred_id === params[1]);
    if (r) { r.commission_earned = (r.commission_earned || 0) + params[0]; save(); return { changes: 1 }; }
    return { changes: 0 };
  }
  if (/UPDATE withdrawals SET status = \?/i.test(s)) {
    const w = store.withdrawals.find(x => x.id === params[3]);
    if (w) { w.status = params[0]; w.tx_hash = params[1]; w.admin_note = params[2]; w.processed_at = new Date().toISOString(); save(); return { changes: 1 }; }
    return { changes: 0 };
  }
  if (/UPDATE tasks SET/i.test(s)) {
    const t = store.tasks.find(x => x.id === params[params.length - 1]);
    if (t) {
      if (params[0] != null) t.title = params[0];
      if (params[1] != null) t.description = params[1];
      if (params[2] != null) t.reward = params[2];
      if (params[3] != null) t.type = params[3];
      if (params[4] != null) t.target_url = params[4];
      if (params[5] != null) t.channel_id = params[5];
      if (params[6] != null) t.is_active = params[6];
      if (params[7] != null) t.sort_order = params[7];
      save(); return { changes: 1 };
    }
    return { changes: 0 };
  }
  if (/INSERT OR IGNORE INTO settings|INSERT INTO settings/i.test(s)) {
    if (store.settings[params[0]] === undefined) { store.settings[params[0]] = params[1]; save(); }
    return { changes: 1 };
  }

  console.warn('Unhandled SQL:', s.slice(0, 100));
  return mode === 'run' ? { changes: 0 } : (mode === 'all' ? [] : undefined);
}

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'migrate') migrate();
  else if (cmd === 'seed') { migrate(); seed(); }
  else console.log('Usage: node db.js [migrate|seed]');
}

function ensureUserBalances(user) {
  if (!user) return user;
  if (user.ton_balance == null) user.ton_balance = 0;
  if (user.gram_balance == null) user.gram_balance = 0;
  if (user.usdt_credited == null) user.usdt_credited = 0;
  if (user.withdraw_unlocked == null) user.withdraw_unlocked = 0;
  return user;
}

function getStore() {
  // memory only — never reload (prevents wiping live balances/tasks)
  return store;
}

function saveStore() {
  save();
}

// Explicit named exports — works under CJS and Wrangler CJS/ESM interop
const _exports = {
  db,
  migrate,
  seed,
  getSetting,
  setSetting,
  getAllSettings,
  transaction,
  ensureUserBalances,
  getStore,
  saveStore,
  nextId,
  setKvBinding,
  loadFromKv,
  flushPending,
  saveNow
};
module.exports = _exports;
// Some bundlers only surface .default from CJS
module.exports.default = _exports;

