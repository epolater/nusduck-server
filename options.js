const axios = require('axios');

function nullResult() {
  return { pcr: null, maxPain: null, ivAvg: null, ivRank: null, expiryDate: null };
}

async function getNearestExpiry(symbol) {
  const res = await axios.get(
    `https://api.marketdata.app/v1/options/expirations/${symbol}/`,
    { timeout: 8000 }
  );
  const expirations = res.data?.expirations ?? [];
  return expirations[0] ?? null;
}

async function fetchOptionsData(symbol) {
  try {
    const expiry = await getNearestExpiry(symbol);
    if (!expiry) return nullResult();

    const res = await axios.get(
      `https://api.marketdata.app/v1/options/chain/${symbol}/`,
      { params: { expiration: expiry }, timeout: 10000 }
    );

    const d = res.data;
    if (d?.s !== 'ok' || !d.strike?.length) return nullResult();

    const sides  = d.side;
    const strikes = d.strike;
    const volumes = d.volume;
    const ois    = d.openInterest;
    const ivs    = d.iv;
    const underlyingPrice = d.underlyingPrice?.[0] ?? 0;
    const expiryDate = expiry;

    const calls = strikes.map((s, i) => ({ strike: s, volume: volumes[i] ?? 0, oi: ois[i] ?? 0, iv: ivs[i] ?? 0 })).filter((_, i) => sides[i] === 'call');
    const puts  = strikes.map((s, i) => ({ strike: s, volume: volumes[i] ?? 0, oi: ois[i] ?? 0, iv: ivs[i] ?? 0 })).filter((_, i) => sides[i] === 'put');

    if (!calls.length && !puts.length) return nullResult();

    // PCR — put volume / call volume
    const callVol = calls.reduce((s, o) => s + o.volume, 0);
    const putVol  = puts.reduce((s, o)  => s + o.volume, 0);
    const pcr = callVol > 0 ? putVol / callVol : null;

    // Max Pain — strike minimising total option holder payout
    const allStrikes = [...new Set([...calls, ...puts].map(o => o.strike))].sort((a, b) => a - b);
    let maxPain = null, minLoss = Infinity;
    for (const s of allStrikes) {
      const callLoss = calls.reduce((sum, o) => sum + o.oi * Math.max(0, s - o.strike), 0);
      const putLoss  = puts.reduce((sum, o)  => sum + o.oi * Math.max(0, o.strike - s), 0);
      const total = callLoss + putLoss;
      if (total < minLoss) { minLoss = total; maxPain = s; }
    }

    // IV Average — ATM options only (within 5% of current price)
    const atm = [...calls, ...puts].filter(o =>
      underlyingPrice > 0 && Math.abs(o.strike - underlyingPrice) / underlyingPrice < 0.05 && o.iv > 0
    );
    const ivAvg = atm.length > 0 ? atm.reduce((s, o) => s + o.iv, 0) / atm.length : null;

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
