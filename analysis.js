// Technical analysis — ported from utils/technicalAnalysis.ts

function avgVolume(volume, days) {
  const slice = volume.slice(-days);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function computeSMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function computeEMAFull(closes, period) {
  if (closes.length < period) return [];
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result = [ema];
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const changes = closes.slice(1).map((c, i) => c - closes[i]);
  const gains = changes.map(c => Math.max(0, c));
  const losses = changes.map(c => Math.max(0, -c));
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < changes.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function computeMACD(closes, fastP = 12, slowP = 26, signalP = 9) {
  const fast = computeEMAFull(closes, fastP);
  const slow = computeEMAFull(closes, slowP);
  const offset = slowP - fastP;
  const macdLine = slow.map((s, i) => fast[i + offset] - s);
  const signalLine = computeEMAFull(macdLine, signalP);
  const sigOffset = signalP - 1;
  return { macdLine: macdLine.slice(sigOffset), signalLine };
}

function meetsUniverseFilter(candles, minPrice = 5, minAvgVolume = 500000) {
  const n = candles.close.length;
  if (n === 0) return false;
  if (candles.close[n - 1] < minPrice) return false;
  if (candles.volume.length >= 20) {
    const avg = avgVolume(candles.volume, 20);
    if (avg < minAvgVolume) return false;
  }
  return true;
}

function evaluateCriteria(criteria, candles) {
  const { close, high, low, open, volume } = candles;
  const n = close.length;
  if (n < 2) return null;
  const current = close[n - 1];
  const prev = close[n - 2];

  switch (criteria.id) {
    case 'trending_up': {
      const days = Math.round(criteria.threshold);
      if (n < days + 1) return null;
      const slice = close.slice(-(days + 1));
      const matched = slice.every((v, i) => i === 0 || v > slice[i - 1]);
      if (!matched) return null;
      const pctChange = slice[1] > 0 ? ((slice[slice.length - 1] - slice[1]) / slice[1]) * 100 : 0;
      return { matched: true, detail: `${days} up days (+${pctChange.toFixed(2)}%)`, value: pctChange };
    }
    case 'trending_down': {
      const days = Math.round(criteria.threshold);
      if (n < days + 1) return null;
      const slice = close.slice(-(days + 1));
      const matched = slice.every((v, i) => i === 0 || v < slice[i - 1]);
      if (!matched) return null;
      const pctChange = slice[1] > 0 ? ((slice[slice.length - 1] - slice[1]) / slice[1]) * 100 : 0;
      return { matched: true, detail: `${days} down days (${pctChange.toFixed(2)}%)`, value: pctChange };
    }
    case 'rsi_oversold': {
      const rsi = computeRSI(close);
      if (rsi == null) return null;
      return rsi < criteria.threshold ? { matched: true, detail: `RSI ${rsi.toFixed(1)} < ${criteria.threshold}` } : null;
    }
    case 'rsi_overbought': {
      const rsi = computeRSI(close);
      if (rsi == null) return null;
      return rsi > criteria.threshold ? { matched: true, detail: `RSI ${rsi.toFixed(1)} > ${criteria.threshold}` } : null;
    }
    case 'above_sma50': {
      const period = Math.round(criteria.threshold);
      const sma = computeSMA(close, period);
      const smaPrev = computeSMA(close.slice(0, -1), period);
      if (!sma || !smaPrev) return null;
      return current > sma && prev <= smaPrev ? { matched: true, detail: `Crossed above SMA${period} ($${sma.toFixed(2)})` } : null;
    }
    case 'below_sma50': {
      const period = Math.round(criteria.threshold);
      const sma = computeSMA(close, period);
      const smaPrev = computeSMA(close.slice(0, -1), period);
      if (!sma || !smaPrev) return null;
      return current < sma && prev >= smaPrev ? { matched: true, detail: `Crossed below SMA${period} ($${sma.toFixed(2)})` } : null;
    }
    case 'volume_spike': {
      if (volume.length < 21) return null;
      const avg = avgVolume(volume.slice(0, -1), 20);
      const todayVol = volume[n - 1];
      return todayVol > avg * criteria.threshold ? { matched: true, detail: `Volume ${(todayVol / avg).toFixed(1)}× 20-day avg` } : null;
    }
    case 'new_52w_high': {
      const lookback = Math.round(criteria.threshold);
      if (n < lookback + 1) return null;
      const prevHigh = Math.max(...close.slice(-(lookback + 1), -1));
      return current > prevHigh ? { matched: true, detail: `New ${lookback}-day high ($${current.toFixed(2)})` } : null;
    }
    case 'new_52w_low': {
      const lookback = Math.round(criteria.threshold);
      if (n < lookback + 1) return null;
      const prevLow = Math.min(...close.slice(-(lookback + 1), -1));
      return current < prevLow ? { matched: true, detail: `New ${lookback}-day low ($${current.toFixed(2)})` } : null;
    }
    case 'price_surge': {
      const period = Math.round(criteria.threshold2 ?? 5);
      if (n < period + 1) return null;
      const startPrice = close[n - 1 - period];
      if (startPrice <= 0) return null;
      const gainPct = ((current - startPrice) / startPrice) * 100;
      return gainPct >= criteria.threshold ? { matched: true, detail: `+${gainPct.toFixed(1)}% over ${period} days` } : null;
    }
    case 'macd_crossover_up': {
      const { macdLine, signalLine } = computeMACD(close, 12, 26, Math.round(criteria.threshold));
      if (macdLine.length < 2 || signalLine.length < 2) return null;
      const crossed = macdLine[macdLine.length - 1] > signalLine[signalLine.length - 1] &&
                      macdLine[macdLine.length - 2] <= signalLine[signalLine.length - 2];
      return crossed ? { matched: true, detail: `MACD crossed above signal` } : null;
    }
    case 'gap_up': {
      if (n < 2 || !open?.length) return null;
      const gapPct = ((open[n - 1] - close[n - 2]) / close[n - 2]) * 100;
      return gapPct >= criteria.threshold ? { matched: true, detail: `Gapped up ${gapPct.toFixed(1)}%` } : null;
    }
    case 'gap_down': {
      if (n < 2 || !open?.length) return null;
      const gapPct = ((close[n - 2] - open[n - 1]) / close[n - 2]) * 100;
      return gapPct >= criteria.threshold ? { matched: true, detail: `Gapped down ${gapPct.toFixed(1)}%` } : null;
    }
    default:
      return null;
  }
}

module.exports = { evaluateCriteria, meetsUniverseFilter };
