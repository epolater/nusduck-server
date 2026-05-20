const { fetchCandles, fetchMarketCap, delay, RATE_LIMIT_MS } = require('./finnhub');
const { evaluateCriteria, meetsUniverseFilter } = require('./analysis');

const CRITERIA_WEIGHTS = {
  trending_up: 2, trending_down: 2, rsi_oversold: 3, rsi_overbought: 3,
  above_sma50: 2, below_sma50: 2, volume_spike: 2, new_52w_high: 4,
  new_52w_low: 4, price_surge: 3, macd_crossover_up: 3, macd_crossover_down: 3,
  ema_crossover_up: 3, ema_crossover_down: 3, bollinger_breakout_up: 3,
  bollinger_breakout_down: 3, gap_up: 3, gap_down: 3, stoch_oversold: 3,
  stoch_overbought: 3, adx_strong: 2, atr_spike: 2, volume_dryup: 1,
  obv_trend_up: 2, obv_trend_down: 2, inside_bar: 1,
};

async function runScan({ universe, criteria, matchMode, minChangePct, minScore, apiKey, onProgress, shouldStop }) {
  const buyCriteria = criteria.filter(c => c.enabled && c.signal === 'buy');
  const marketCapCriteria = buyCriteria.find(c => c.id === 'min_market_cap');
  const regularBuyCriteria = buyCriteria.filter(c => c.id !== 'min_market_cap');

  const signals = [];
  let evaluated = 0, noData = 0, filtered = 0;

  for (let i = 0; i < universe.length; i++) {
    if (shouldStop && shouldStop()) {
      console.log('Scan stopped by user request.');
      break;
    }

    const stock = universe[i];

    if (onProgress) onProgress({ current: i + 1, total: universe.length, evaluated, noData, filtered, found: signals.length });

    const [candles, marketCap] = await Promise.all([
      fetchCandles(stock.symbol, apiKey),
      marketCapCriteria ? fetchMarketCap(stock.symbol, apiKey) : Promise.resolve(null),
    ]);

    if (!candles || candles.close.length < 20) {
      noData++;
      await delay(RATE_LIMIT_MS);
      continue;
    }

    if (!meetsUniverseFilter(candles)) {
      filtered++;
      await delay(RATE_LIMIT_MS);
      continue;
    }

    // Hard filter: market cap
    if (marketCapCriteria) {
      const minCap = marketCapCriteria.threshold * 1_000_000_000;
      if (!marketCap || marketCap < minCap) {
        filtered++;
        await delay(RATE_LIMIT_MS);
        continue;
      }
    }

    const n = candles.close.length;
    const currentPrice = candles.close[n - 1];
    const prevPrice = candles.close[n - 2];
    const changePercent = prevPrice > 0 ? ((currentPrice - prevPrice) / prevPrice) * 100 : 0;

    if (Math.abs(changePercent) < (minChangePct ?? 1)) {
      filtered++;
      await delay(RATE_LIMIT_MS);
      continue;
    }

    const buyResults = regularBuyCriteria.map(c => ({ c, result: evaluateCriteria(c, candles) }));
    const matchedBuy = buyResults.filter(r => r.result?.matched);

    const buyPassed = regularBuyCriteria.length === 0 ? false
      : matchMode === 'any' ? matchedBuy.length > 0
      : matchedBuy.length === regularBuyCriteria.length;

    if (!buyPassed) {
      evaluated++;
      await delay(RATE_LIMIT_MS);
      continue;
    }

    evaluated++;

    const matchedCriteria = matchedBuy.map(r => `${r.c.name}: ${r.result.detail}`);

    const score = Math.round(matchedBuy.reduce((sum, r) => {
      const baseWeight = CRITERIA_WEIGHTS[r.c.id] ?? 1;
      if ((r.c.id === 'trending_up' || r.c.id === 'trending_down') && r.result?.value != null) {
        const absPct = Math.abs(r.result.value);
        const dynamicWeight = Math.max(baseWeight, absPct / 2);
        return sum + (r.c.id === 'trending_down' ? -dynamicWeight : dynamicWeight);
      }
      return sum + baseWeight;
    }, 0));

    if (score < (minScore ?? 1)) {
      await delay(RATE_LIMIT_MS);
      continue;
    }

    signals.push({
      symbol: stock.symbol,
      name: stock.name,
      signal: 'buy',
      matchedCriteria,
      score,
      price: currentPrice,
      changePercent,
      generatedAt: Date.now(),
    });

    await delay(RATE_LIMIT_MS);
  }

  return { signals, evaluated, noData, filtered };
}

module.exports = { runScan };
