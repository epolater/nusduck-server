const axios = require('axios');

function nullResult() {
  return { pcr: null, maxPain: null, ivAvg: null, ivRank: null, expiryDate: null };
}

async function fetchOptionsData(symbol, apiKey) {
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };

  try {
    // 1. Get nearest expiry
    const expRes = await axios.get('https://api.tradier.com/v1/markets/options/expirations', {
      params: { symbol, includeAllRoots: true },
      headers, timeout: 10000,
    });
    const raw = expRes.data?.expirations?.date;
    if (!raw) return nullResult();
    const dates = Array.isArray(raw) ? raw : [raw];
    const nearest = dates[0];

    // 2. Get options chain
    const chainRes = await axios.get('https://api.tradier.com/v1/markets/options/chains', {
      params: { symbol, expiration: nearest, greeks: true },
      headers, timeout: 10000,
    });
    const options = chainRes.data?.options?.option;
    if (!options?.length) return nullResult();

    const underlyingLast = options[0]?.underlying?.last ?? 0;
    const calls = options.filter(o => o.option_type === 'call');
    const puts  = options.filter(o => o.option_type === 'put');

    // PCR
    const callVol = calls.reduce((s, o) => s + (o.volume || 0), 0);
    const putVol  = puts.reduce((s, o)  => s + (o.volume || 0), 0);
    const pcr = callVol > 0 ? putVol / callVol : null;

    // Max Pain
    const strikes = [...new Set(options.map(o => o.strike))].sort((a, b) => a - b);
    let maxPain = null, minLoss = Infinity;
    for (const s of strikes) {
      const callLoss = calls.reduce((sum, o) => sum + (o.open_interest || 0) * Math.max(0, s - o.strike), 0);
      const putLoss  = puts.reduce((sum, o)  => sum + (o.open_interest || 0) * Math.max(0, o.strike - s), 0);
      const total = callLoss + putLoss;
      if (total < minLoss) { minLoss = total; maxPain = s; }
    }

    // IV Average (ATM ±5%)
    const atm = options.filter(o => underlyingLast > 0 && Math.abs(o.strike - underlyingLast) / underlyingLast < 0.05);
    const ivs = atm.map(o => o.greeks?.mid_iv).filter(v => v != null && v > 0);
    const ivAvg = ivs.length > 0 ? ivs.reduce((s, v) => s + v, 0) / ivs.length : null;
    const ivRank = ivAvg != null ? (ivAvg > 0.6 ? 80 : ivAvg > 0.4 ? 60 : ivAvg > 0.25 ? 40 : 20) : null;

    return { pcr, maxPain, ivAvg, ivRank, expiryDate: nearest };
  } catch (e) {
    console.error(`[tradier] ${e.message}`);
    return nullResult();
  }
}

module.exports = { fetchOptionsData };
