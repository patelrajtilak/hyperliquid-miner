/**
 * Telegram WebApp initData validation
 * Official algorithm: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
const crypto = require('crypto');

/**
 * Validate Telegram WebApp initData
 * @param {string} initData - raw initData string from Telegram.WebApp.initData
 * @param {string} botToken - Bot token from BotFather
 * @param {number} maxAgeSeconds - max age of auth_date (default 1 day)
 * @returns {{ valid: boolean, user?: object, error?: string }}
 */
function validateInitData(initData, botToken, maxAgeSeconds = 86400) {
  if (!initData || !botToken) {
    return { valid: false, error: 'Missing initData or bot token' };
  }

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return { valid: false, error: 'No hash in initData' };

    params.delete('hash');

    // Sort keys alphabetically and build data-check-string
    const entries = [];
    for (const [key, value] of params.entries()) {
      entries.push(`${key}=${value}`);
    }
    entries.sort();
    const dataCheckString = entries.join('\n');

    // secret_key = HMAC_SHA256(<bot_token>, "WebAppData")
    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(botToken)
      .digest();

    // calculated_hash = HMAC_SHA256(data_check_string, secret_key)
    const calculatedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if (calculatedHash !== hash) {
      return { valid: false, error: 'Hash mismatch – invalid initData' };
    }

    // Check auth_date freshness
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    const now = Math.floor(Date.now() / 1000);
    if (now - authDate > maxAgeSeconds) {
      return { valid: false, error: 'initData expired' };
    }

    // Parse user
    let user = null;
    const userJson = params.get('user');
    if (userJson) {
      user = JSON.parse(userJson);
    }

    // start_param for referral
    const startParam = params.get('start_param') || null;

    return {
      valid: true,
      user,
      startParam,
      authDate,
      queryId: params.get('query_id') || null
    };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

/**
 * Generate a short referral code from user id
 */
function generateReferralCode(telegramId) {
  const hash = crypto.createHash('sha256').update(String(telegramId) + (process.env.REFERRAL_SALT || 'hype')).digest('hex');
  return 'HYPE' + hash.slice(0, 8).toUpperCase();
}

/**
 * Send a message via Telegram Bot API
 * @param {string|number} chatId - Telegram user id
 * @param {string} text - message body
 * @param {object} [replyMarkup] - optional InlineKeyboardMarkup
 */
async function sendBotMessage(chatId, text, replyMarkup) {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.warn('[telegram] BOT_TOKEN missing — skip send');
    return { ok: false, error: 'BOT_TOKEN not set' };
  }
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (replyMarkup) body.reply_markup = replyMarkup;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!data.ok) {
      console.warn('[telegram] sendMessage failed:', data.description || data);
    }
    return data;
  } catch (err) {
    console.warn('[telegram] sendMessage error:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Resolve Open App + Join Community URLs (env first, then HQ settings)
 */
function getBotLinks() {
  let webappUrl = process.env.WEBAPP_URL || process.env.MINI_APP_URL || '';
  let community = process.env.COMMUNITY_CHANNEL_URL || '';
  let botUser = (process.env.BOT_USERNAME || '').replace('@', '');
  try {
    const { getSetting } = require('../db');
    if (!webappUrl) webappUrl = getSetting('webapp_url', '') || '';
    if (!community) community = getSetting('community_channel_url', '') || '';
  } catch (_) {}
  if (!community) community = 'https://t.me/HypeMinerOfficial';
  webappUrl = String(webappUrl || '').trim();
  community = String(community || '').trim();
  return { webappUrl, community, botUser };
}

/**
 * DIGGO-style keyboard: always 2 buttons — Open App + Join Community
 */
function buildMiningPauseKeyboard() {
  const { webappUrl, community, botUser } = getBotLinks();
  const openRow = [];

  // Prefer Mini App web_app button (opens inside Telegram like DIGGO)
  if (webappUrl && /^https:\/\//i.test(webappUrl)) {
    openRow.push({ text: '⛏ Open HYPE Miner', web_app: { url: webappUrl } });
  } else if (botUser) {
    // Fallback: deep-link to bot (user taps Start / open mini app from bot)
    openRow.push({ text: '⛏ Open HYPE Miner', url: `https://t.me/${botUser}` });
  } else if (webappUrl) {
    openRow.push({ text: '⛏ Open HYPE Miner', url: webappUrl });
  }

  const keyboard = [];
  if (openRow.length) keyboard.push(openRow);
  // Always show Join Community
  keyboard.push([{ text: '🤝 Join Community', url: community || 'https://t.me/HypeMinerOfficial' }]);
  return { inline_keyboard: keyboard };
}

/** Welcome message like DIGGO (on first open) */
function buildWelcomeText(appName) {
  const name = appName || 'HYPE MINER';
  return (
    `⛏ <b>Welcome to ${name}!</b> 💎\n\n` +
    `Your mining adventure starts here.\n\n` +
    `⚡ Mine HYPE and collect every few hours.\n` +
    `📈 Grow your holding to unlock levels.\n` +
    `🎯 Complete tasks and keep your streak.\n` +
    `🤝 Invite friends and earn together.\n\n` +
    `✨ Tap below and start mining!`
  );
}

function buildPauseText(hours, appName) {
  const h = hours || 8;
  const name = appName || 'HYPE MINER';
  return (
    `💎 Your <b>HYPE</b> is ready to claim!\n\n` +
    `⏸ Mining has paused after <b>${h} hours</b>. ` +
    `Collect your rewards to start mining again.\n\n` +
    `Open <b>${name}</b> and keep earning.`
  );
}

module.exports = {
  validateInitData,
  generateReferralCode,
  sendBotMessage,
  buildMiningPauseKeyboard,
  buildWelcomeText,
  buildPauseText,
  getBotLinks
};
