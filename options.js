const axios = require('axios');

function nullResult() {
  return { pcr: null, maxPain: null, ivAvg: null, ivRank: null, expiryDate: null };
}

// CBOE delayed quotes — free, no API key, covers all optionable US stocks
async function fetchOptionsData(symbol) {
  try {
    const res = await axios.get(
      `https://cdn.cboe.com/api/global/delayed_quotes/options/${symbol}.json`,
      { timeout: 10000 }
    );

    const data = res.data?.data;
    if (!data?.options?.length) return nullResult();

    const underlyingPrice = data.current_price ?? 0;
    const iv30 = data.iv30 ?? null; // 30-day IV % (e.g. 38.3 = 38.3%)

    const calls = [];
    const puts  = [];
    let nearestExpiry = null;

    for (const o of data.options) {
      const m = o.option?.match(/[A-Z]+(\d{2})(\d{2})(\d{2})([CP])(\d+)/);
      if (!m) continue;
      const [, yy, mm, dd, side, strikeRaw] = m;
      const expiry = `20${yy}-${mm}-${dd}`;
      if (!nearestExpiry || expiry < nearestExpiry) nearestExpiry = expiry;

      const strike = parseInt(strikeRaw) / 1000;
      const vol = o.volume ?? 0;
      const oi  = o.open_interest ?? 0;
      if (side === 'C') calls.push({ strike, volume: vol, oi });
      else              puts.push({ strike, volume: vol, oi });
    }

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

    // IV: use CBOE's iv30 directly (already a %, convert to 0–1)
    const ivAvg = iv30 != null && iv30 > 0 ? iv30 / 100 : null;

    const ivRank = ivAvg != null
      ? ivAvg > 0.6 ? 80 : ivAvg > 0.4 ? 60 : ivAvg > 0.25 ? 40 : 20
      : null;

    return { pcr, maxPain, ivAvg, ivRank, expiryDate: nearestExpiry };
  } catch (e) {
    console.error(`[options] ${symbol}: ${e.message}`);
    return nullResult();
  }
}

module.exports = { fetchOptionsData };
