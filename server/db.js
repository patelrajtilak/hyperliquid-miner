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
  _seq: { users: 1, tasks: 1, user_tasks: 1, mining_log: 1, referrals: 1, withdrawals: 1, deposits: 1, swaps: 1, admins: 1, activity_log: 1 }
});

let store = EMPTY_STORE();
let loadedOnce = false;
let saveTimer = null;
let dirty = false;

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
    // Cloudflare KV (async fire-and-forget)
    if (kvBinding) {
      try {
        const p = kvBinding.put(KV_KEY, json);
        if (p && typeof p.then === 'function') {
          p.catch(e => console.error('[db] KV put failed', e.message));
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

/** Async load from KV (call once at CF boot). Returns true if loaded. */
async function loadFromKv() {
  if (!kvBinding) return false;
  try {
    const raw = await kvBinding.get(KV_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && typeof data === 'object' && Array.isArray(data.users)) {
        store = data;
        loadedOnce = true;
        console.log('[db] loaded from KV, users=', store.users.length);
        return true;
      }
    }
  } catch (e) {
    console.warn('[db] KV load failed', e.message);
  }
  return false;
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

// Flush on exit (Node only — Workers have no process signals 
