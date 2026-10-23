/**
 * Node.js entry — local / Render / Railway / any Node host
 */
require('dotenv').config();
const { createApp } = require('./app');
const { migrate, seed } = require('./db');

const app = createApp();
const PORT = process.env.PORT || 3000;
const adminPath = (process.env.ADMIN_PANEL_PATH || '/hq-control').replace(/\/$/, '');

// Boot
migrate();
seed();

// DIGGO-style 8h mining-pause reminders via Telegram bot
try {
  const { startMiningPauseScheduler } = require('./jobs/miningPauseNotify');
  startMiningPauseScheduler(5 * 60 * 1000);
} catch (err) {
  console.warn('Mining pause scheduler not started:', err.message);
}

// Soft anti-sleep: ping own health URL every 10 min (helps free Render stay warmer)
try {
  const keepUrl = process.env.WEBAPP_URL || process.env.KEEP_ALIVE_URL || '';
  if (keepUrl && process.env.DISABLE_KEEP_ALIVE !== 'true') {
    const ping = () => {
      const u = keepUrl.replace(/\/$/, '') + '/api/health';
      fetch(u).catch(() => {});
    };
    setTimeout(ping, 30 * 1000);
    setInterval(ping, 10 * 60 * 1000);
    console.log('[keep-alive] pinging', keepUrl, 'every 10 min');
  }
} catch (e) {
  console.warn('keep-alive not started', e.message);
}

app.listen(PORT, () => {
  console.log(`Hyperliquid Miner (HYPE MINER) server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}${adminPath}`);
});
