const axios = require('axios');

const RATE_LIMIT_MS = 500;

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchCandles(symbol, apiKey) {
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

async function fetchMarketCap(symbol, apiKey) {
  try {
    await delay(RATE_LIMIT_MS);
    const res = await axios.get(`https://finnhub.io/api/v1/stock/profile2?symbol=${symbol}&token=${apiKey}`, { timeout: 8000 });
    const cap = res.data?.marketCapitalization;
    return cap ? cap * 1_000_000 : null;
  } catch {
    return null;
  }
}

async function fetchNasdaqSymbols(apiKey) {
  const res = await axios.get(`https://finnhub.io/api/v1/stock/symbol?exchange=US&token=${apiKey}`, { timeout: 30000 });
  return res.data
    .filter(s => s.type === 'Common Stock' && /^[A-Z]{1,4}$/.test(s.symbol))
    .map(s => ({ symbol: s.symbol, name: s.description }));
}

module.exports = { fetchCandles, fetchMarketCap, fetchNasdaqSymbols, delay, RATE_LIMIT_MS };
