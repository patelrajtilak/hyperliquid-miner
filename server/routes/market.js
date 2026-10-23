const express = require('express');
const router = express.Router();
const { db, getSetting } = require('../db');
const { optionalAuth } = require('../middleware/auth');

/**
 * GET /api/market
 * Live pool + ecosystem stats. Optional external price feed if configured.
 */
router.get('/', optionalAuth, async (req, res) => {
  const symbol = getSetting('token_symbol', 'HYPE');
  const targetCap = parseFloat(getSetting('target_cap', '2000000')) || 2000000;
  const customApi = getSetting('market_api_url', '') || process.env.MARKET_API_URL;

  // Network / pool stats from real DB
  const totalMinedRow = db.prepare('SELECT COALESCE(SUM(total_mined), 0) as s FROM users').get();
  const usersRow = db.prepare('SELECT COUNT(*) as c FROM users').get();
  const totalMined = Number(totalMinedRow?.s || 0);
  const miners = Number(usersRow?.c || 0);
  const remaining = Math.max(0, targetCap - totalMined);
  const minedPct = targetCap > 0 ? Math.min(100, (totalMined / targetCap) * 100) : 0;

  let priceData = null;
  if (customApi) {
    try {
      const response = await fetch(customApi);
      if (response.ok) {
        priceData = await response.json();
      }
    } catch (e) {
      console.warn('Market API:', e.message);
    }
  }

  res.json({
    symbol,
    network: {
      totalMined: Number(totalMined.toFixed(2)),
      targetCap,
      remaining: Number(remaining.toFixed(2)),
      minedPercent: Number(minedPct.toFixed(2)),
      activeMiners: miners
    },
    price: priceData?.price ?? null,
    change24h: priceData?.change24h ?? null,
    volume24h: priceData?.volume24h ?? null,
    marketCap: priceData?.marketCap ?? null,
    high24h: priceData?.high24h ?? null,
    low24h: priceData?.low24h ?? null,
    source: priceData ? 'live' : 'pool'
  });
});

module.exports = router;
