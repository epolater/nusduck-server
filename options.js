const axios = require('axios');

function nullResult() {
  return { pcr: null, maxPain: null, ivAvg: null, ivRank: null, expiryDate: null };
}

async function fetchOptionsData(symbol) {
  try {
    const res = await axios.get(
      `https://query1.finance.yahoo.com/v7/finance/options/${symbol}`,
      { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );

    const result = res.data?.optionChain?.result?.[0];
    if (!result) return nullResult();

    const underlyingPrice = result.quote?.regularMarketPrice ?? 0;
    const expiryTs = result.options?.[0]?.expirationDate;
    const expiryDate = expiryTs
      ? new Date(expiryTs * 1000).toISOString().slice(0, 10)
      : null;

    const calls = result.options?.[0]?.calls ?? [];
    const puts  = result.options?.[0]?.puts  ?? [];
    if (!calls.length && !puts.length) return nullResult();

    // PCR — put volume / call volume
    const callVol = calls.reduce((s, o) => s + (o.volume ?? 0), 0);
    const putVol  = puts.reduce((s, o)  => s + (o.volume ?? 0), 0);
    const pcr = callVol > 0 ? putVol / callVol : null;

    // Max Pain — strike minimising total option holder payout
    const allStrikes = [...new Set([...calls, ...puts].map(o => o.strike))].sort((a, b) => a - b);
    let maxPain = null, minLoss = Infinity;
    for (const s of allStrikes) {
      const callLoss = calls.reduce((sum, o) => sum + (o.openInterest ?? 0) * Math.max(0, s - o.strike), 0);
      const putLoss  = puts.reduce((sum, o)  => sum + (o.openInterest ?? 0) * Math.max(0, o.strike - s), 0);
      const total = callLoss + putLoss;
      if (total < minLoss) { minLoss = total; maxPain = s; }
    }

    // IV Average — ATM options only (within 5% of current price)
    const atm = [...calls, ...puts].filter(o =>
      underlyingPrice > 0 && Math.abs(o.strike - underlyingPrice) / underlyingPrice < 0.05
    );
    const ivs = atm.map(o => o.impliedVolatility).filter(v => v != null && v > 0);
    const ivAvg = ivs.length > 0 ? ivs.reduce((s, v) => s + v, 0) / ivs.length : null;

    const ivRank = ivAvg != null
      ? ivAvg > 0.6 ? 80 : ivAvg > 0.4 ? 60 : ivAvg > 0.25 ? 40 : 20
      : null;

    return { pcr, maxPain, ivAvg, ivRank, expiryDate };
  } catch (e) {
    console.error(`[options] ${symbol}: ${e.message}`);
    return nullResult();
  }
}

module.exports = { fetchOptionsData };
