/**
 * Runtime config — Cloudflare Worker injects secrets here via applyWorkerEnv().
 * process.env alone is unreliable across CF isolates / nodejs_compat.
 */
const state = {
  BOT_TOKEN: '',
  JWT_SECRET: '',
  ADMIN_PASSWORD: '',
  ADMIN_USERNAME: '',
  WEBAPP_URL: '',
  REFERRAL_SALT: '',
  ADMIN_TELEGRAM_IDS: '',
  COMMUNITY_CHANNEL_URL: '',
  ADMIN_PANEL_PATH: '',
  BOT_USERNAME: '',
  ALLOW_DEV_LOGIN: ''
};

function applyWorkerEnv(env) {
  if (!env) return;
  const keys = Object.keys(state);
  for (const key of keys) {
    try {
      const v = env[key];
      if (typeof v === 'string' && v.length > 0) {
        state[key] = v;
        try {
          process.env[key] = v;
        } catch (_) {}
      }
    } catch (_) {}
  }
  // Also copy any other string env bindings
  try {
    for (const key of Object.keys(env)) {
      const v = env[key];
      if (typeof v === 'string' && v.length > 0) {
        try {
          process.env[key] = v;
        } catch (_) {}
        if (key in state) state[key] = v;
      }
    }
  } catch (_) {}
}

function get(key, fallback) {
  if (state[key] && String(state[key]).length > 0) return state[key];
  if (process.env[key] && String(process.env[key]).length > 0) return process.env[key];
  return fallback != null ? fallback : '';
}

function getBotToken() {
  return get('BOT_TOKEN', '');
}

function getJwtSecret() {
  return get('JWT_SECRET', 'change-me-in-production-hype-miner-secret');
}

module.exports = {
  applyWorkerEnv,
  get,
  getBotToken,
  getJwtSecret,
  state
};
module.exports.default = module.exports;
