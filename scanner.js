const { fetchCandles, fetchMarketCap, delay, RATE_LIMIT_MS } = require('./finnhub');
const { evaluateCriteria, meetsUniverseFilter } = require('./analysis');
const { fetchOptionsData } = require('./options');

const CRITERIA_WEIGHTS = {
  trending_up: 2, trending_down: 2, rsi_oversold: 3, rsi_overbought: 3,
  above_sma50: 2, below_sma50: 2, volume_spike: 2, new_52w_high: 4,
  new_52w_low: 4, price_surge: 3, macd_crossover_up: 3, macd_crossover_down: 3,
  ema_crossover_up: 3, ema_crossover_down: 3, bollinger_breakout_up: 3,
  bollinger_breakout_down: 3, gap_up: 3, gap_down: 3, stoch_oversold: 3,
  stoch_overbought: 3, adx_strong: 2, atr_spike: 2, volume_dryup: 1,
  obv_trend_up: 2, obv_trend_down: 2, inside_bar: 1,
  put_call_ratio_low: 3, put_call_ratio_high: 3, high_iv: 2, near_max_pain: 2,
};

async function runScan({ universe, criteria, matchMode, minChangePct, minScore, minMarketCap, criteriaWeights, apiKey, onProgress, shouldStop, fromIndex = 0, existingSignals = [] }) {
  // Merge server defaults with any user-supplied weight overrides
  const weights = criteriaWeights ? { ...CRITERIA_WEIGHTS, ...criteriaWeights } : CRITERIA_WEIGHTS;
  const buyCriteria = criteria.filter(c => c.enabled && c.signal === 'buy');
  const regularBuyCriteria = buyCriteria;
  const marketCapFilterEnabled = minMarketCap > 0;

  const signals = [...existingSignals];
  let evaluated = 0, noData = 0, filtered = 0;

  for (let i = fromIndex; i < universe.length; i++) {
    if (shouldStop && shouldStop()) {
      console.log('Scan stopped by user request at index', i);
      return { signals, evaluated, noData, filtered, stopIndex: i };
    }

    const stock = universe[i];

    if (onProgress) onProgress({ current: i + 1, total: universe.length, evaluated, noData, filtered, found: signals.length, partialSignals: signals });

    const [candles, marketCap] = await Promise.all([
      fetchCandles(stock.symbol, apiKey),
      marketCapFilterEnabled ? fetchMarketCap(stock.symbol, apiKey) : Promise.resolve(null),
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
    if (marketCapFilterEnabled) {
      const minCap = minMarketCap * 1_000_000_000;
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

    let score = Math.round(matchedBuy.reduce((sum, r) => {
      const baseWeight = weights[r.c.id] ?? 1;
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

    // Enrich with options data via Yahoo Finance (no key required)
    let optionsData = null;
    try {
      optionsData = await fetchOptionsData(stock.symbol);
      const optionsCriteriaIds = ['put_call_ratio_low', 'put_call_ratio_high', 'high_iv', 'near_max_pain'];
      const optionsCriteria = criteria.filter(c => c.enabled && optionsCriteriaIds.includes(c.id));
      for (const c of optionsCriteria) {
        let matched = false, detail = '';
        if (c.id === 'put_call_ratio_low' && optionsData.pcr != null) {
          matched = optionsData.pcr < 0.7; detail = `PCR: ${optionsData.pcr.toFixed(2)}`;
        } else if (c.id === 'put_call_ratio_high' && optionsData.pcr != null) {
          matched = optionsData.pcr > 1.0; detail = `PCR: ${optionsData.pcr.toFixed(2)}`;
        } else if (c.id === 'high_iv' && optionsData.ivAvg != null) {
          matched = optionsData.ivAvg > 0.4; detail = `IV: ${(optionsData.ivAvg * 100).toFixed(1)}%`;
        } else if (c.id === 'near_max_pain' && optionsData.maxPain != null) {
          matched = Math.abs(currentPrice - optionsData.maxPain) / optionsData.maxPain < 0.03;
          detail = `MaxPain: $${optionsData.maxPain.toFixed(2)}`;
        }
        if (matched) { matchedCriteria.push(`${c.name}: ${detail}`); score += weights[c.id] ?? 1; }
      }
    } catch (_) {}

    signals.push({
      symbol: stock.symbol,
      name: stock.name,
      signal: 'buy',
      matchedCriteria,
      score,
      price: currentPrice,
      changePercent,
      generatedAt: Date.now(),
      marketCap: marketCap ?? candles.marketCap ?? null,
      optionsData,
    });

    await delay(RATE_LIMIT_MS);
  }

  return { signals, evaluated, noData, filtered, stopIndex: null };
}

module.exports = { runScan };
