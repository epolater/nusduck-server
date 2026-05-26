const axios = require('axios');

const RATE_LIMIT_MS = 500;

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchCandles(symbol) {
  const to = Math.floor(Date.now() / 1000);
  const from = to - 86400 * 260;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&period1=${from}&period2=${to}`;
    const res = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000,
    });
    const result = res.data?.chart?.result?.[0];
    if (!result) return null;
    const { close, open, high, low, volume } = result.indicators.quote[0];
    const timestamps = result.timestamp;
    return { close, open, high, low, volume, timestamp: timestamps };
  } catch {
    return null;
  }
}

// Market cap comes from Yahoo Finance chart meta (same request as candles — no extra call needed)
async function fetchMarketCap(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`;
    const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
    const m = res.data?.chart?.result?.[0]?.meta;
    return m?.regularMarketCap ?? m?.marketCap ?? null;
  } catch {
    return null;
  }
}

// NASDAQ screener — same tiers as the app
async function fetchNasdaqSymbols(tier = 10) {
  const tierMap = {
    0:   [],
    0.3: ['small', 'mid', 'large', 'mega'],
    2:   ['mid', 'large', 'mega'],
    10:  ['large', 'mega'],
    200: ['mega'],
  };
  const tiers = tierMap[tier] ?? ['large', 'mega'];
  const marketcapParam = tiers.length > 0 ? `&marketcap=${tiers.join('%7C')}` : '';
  const res = await axios.get(
    `https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=9999&exchange=NASDAQ${marketcapParam}`,
    { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 30000 }
  );
  const rows = res.data?.data?.table?.rows ?? [];
  return rows
    .filter(r => r.symbol && /^[A-Z]{1,5}$/.test(r.symbol))
    .map(r => {
      // marketCap from screener is a comma-separated string in dollars (e.g. "5,199,612,000,000")
      const raw = r.marketCap;
      const cap = typeof raw === 'string' ? Number(raw.replace(/[$,]/g, '')) : null;
      return {
        symbol: r.symbol,
        name: r.name ?? r.symbol,
        marketCap: cap && cap > 0 ? cap : null,
      };
    });
}

module.exports = { fetchCandles, fetchMarketCap, fetchNasdaqSymbols, delay, RATE_LIMIT_MS };
