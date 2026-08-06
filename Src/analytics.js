// All analytics here run on OHLC candles only (no order book exists for
// forex/futures/indices the way it does on a crypto exchange). "Liquidity"
// in this app means price-structure liquidity: swing highs/lows and equal
// highs/lows where stop orders are known to cluster - the standard
// price-action meaning of the term in FX/futures trading, not literal
// resting order book depth.

export function fmtPrice(n, symbol) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  const digits = pricePrecision(symbol, n);
  return Number(n).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

export function pricePrecision(symbol, price) {
  if (!symbol) return 2;
  if (symbol.includes("JPY")) return 3;
  if (symbol.startsWith("XAU") || symbol.startsWith("XAG")) return 2;
  if (symbol.includes("/")) return 5; // most forex pairs
  return price >= 1000 ? 1 : 2; // indices / oil
}

export function fmtPct(n, digits = 2) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return sign + n.toFixed(digits) + "%";
}

export function timeAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

// ---------- swing highs / lows -> liquidity pools ----------
// A swing high/low is a local extreme (fractal) over `lookback` candles
// either side. Nearby swing points get clustered into "pools" - the more
// times a level was tested, the stronger the pool (more resting stops).
export function findLiquidityPools(candles, midPrice) {
  if (!candles || candles.length < 10) return { magnet: null, target: null, pools: [], bucketSize: 0 };

  const lookback = 2;
  const swings = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    let isHigh = true, isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low <= c.low) isLow = false;
    }
    if (isHigh) swings.push({ price: c.high, side: "high", time: c.time });
    if (isLow) swings.push({ price: c.low, side: "low", time: c.time });
  }
  if (swings.length === 0) return { magnet: null, target: null, pools: [], bucketSize: 0 };

  const bucketSize = Math.max(midPrice * 0.00035, midPrice * 0.00001);
  const round = (p) => Math.round(p / bucketSize) * bucketSize;

  const buckets = {};
  const now = candles[candles.length - 1].time;
  for (const s of swings) {
    const key = round(s.price);
    if (!buckets[key]) buckets[key] = { price: key, touches: 0, lastTouch: 0, side: s.side };
    buckets[key].touches += 1;
    buckets[key].lastTouch = Math.max(buckets[key].lastTouch, s.time);
  }

  const list = Object.values(buckets).map((b) => {
    const dist = Math.abs(b.price - midPrice) / midPrice;
    const recency = 1 - Math.min(1, (now - b.lastTouch) / (1000 * 60 * 60 * 24)); // decays over ~1 day
    const touchScore = Math.min(1, b.touches / 4);
    const distPenalty = Math.min(dist * 30, 1);
    const score = Math.round((touchScore * 0.55 + recency * 0.25 + (1 - distPenalty) * 0.2) * 100);
    return { ...b, dist, score, poolSide: b.price >= midPrice ? "ask" : "bid" };
  });

  list.sort((a, b) => b.score - a.score);
  const magnet = list[0] || null;
  const target = list.filter((b) => magnet && b.price !== magnet.price)[0] || magnet;

  const pools = list.slice(0, 6).sort((a, b) => b.price - a.price);

  return { magnet, target, pools, bucketSize };
}

// ---------- bias / volume-profile-style POC / liquidity sweep ----------
// buyPct here is a body-weighted bullish-candle ratio: a proxy for buying
// vs selling pressure since forex ticks don't carry Binance-style taker
// buy/sell volume.
export function analyzeCandles(candles) {
  if (!candles || candles.length === 0) return null;

  let bullWeight = 0, bearWeight = 0;
  for (const c of candles) {
    const body = Math.abs(c.close - c.open) || (c.high - c.low) * 0.1;
    if (c.close >= c.open) bullWeight += body;
    else bearWeight += body;
  }
  const total = bullWeight + bearWeight || 1;
  const buyPct = (bullWeight / total) * 100;

  // Simple price-time histogram as a proxy volume profile / point of control
  const profile = {};
  let priceStep = null;
  for (const c of candles) {
    if (!priceStep) priceStep = Math.max((c.high - c.low) / 4, c.high * 0.0004) || c.high * 0.0004;
  }
  for (const c of candles) {
    const steps = Math.max(1, Math.round((c.high - c.low) / priceStep));
    const share = 1 / steps;
    for (let i = 0; i < steps; i++) {
      const p = Math.round((c.low + i * priceStep) / priceStep) * priceStep;
      profile[p] = (profile[p] || 0) + share;
    }
  }
  const profileList = Object.entries(profile)
    .map(([p, v]) => ({ price: parseFloat(p), weight: v }))
    .sort((a, b) => b.weight - a.weight);
  const poc = profileList[0] || null;

  // Liquidity sweep: last candle wicks through the prior swing then closes back
  let sweep = null;
  if (candles.length > 12) {
    const last = candles[candles.length - 1];
    const priorSlice = candles.slice(-13, -1);
    const priorLow = Math.min(...priorSlice.map((c) => c.low));
    const priorHigh = Math.max(...priorSlice.map((c) => c.high));
    if (last.low < priorLow && last.close > priorLow) {
      sweep = {
        type: "bullish",
        price: priorLow,
        label: "Liquidity Sweep (bullish)",
        confidence: Math.round(Math.min(95, ((last.close - last.low) / (priorHigh - priorLow || 1)) * 200))
      };
    } else if (last.high > priorHigh && last.close < priorHigh) {
      sweep = {
        type: "bearish",
        price: priorHigh,
        label: "Liquidity Sweep (bearish)",
        confidence: Math.round(Math.min(95, ((last.high - last.close) / (priorHigh - priorLow || 1)) * 200))
      };
    }
  }

  return { buyPct, sellPct: 100 - buyPct, poc, profileList: profileList.slice(0, 12), sweep };
}

// ---------- RSI (Wilder's, 14-period default) ----------
export function computeRSI(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const closes = candles.map((c) => c.close);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ---------- trading sessions (UTC) ----------
export function activeSessions(date = new Date()) {
  const h = date.getUTCHours();
  const sessions = [
    { name: "Sydney", start: 21, end: 6 },
    { name: "Tokyo", start: 0, end: 9 },
    { name: "London", start: 7, end: 16 },
    { name: "New York", start: 12, end: 21 }
  ];
  return sessions.map((s) => {
    const active = s.start < s.end ? h >= s.start && h < s.end : h >= s.start || h < s.end;
    return { ...s, active };
  });
}

export function sessionOverlapStrength(sessions) {
  const activeCount = sessions.filter((s) => s.active).length;
  if (activeCount >= 2) return { label: "HIGH", note: "Session overlap — expect wider ranges & tighter spreads." };
  if (activeCount === 1) return { label: "MODERATE", note: "Single session active — normal liquidity." };
  return { label: "LOW", note: "Between sessions — thin liquidity, watch for spread widening." };
}

// ---------- signal generation ----------
export function generateSignal(kAnalysis, target, price, rsi, trendStrength) {
  if (!kAnalysis || !price || !target) return null;

  let buyScore = 0;
  let sellScore = 0;

  // 1. Bias from body-weighted bullish/bearish ratio (0-30)
  if (kAnalysis.buyPct >= 60) buyScore += 30;
  else if (kAnalysis.buyPct <= 40) sellScore += 30;
  else {
    buyScore += (kAnalysis.buyPct - 40) * 1.5;
    sellScore += (60 - kAnalysis.buyPct) * 1.5;
  }

  // 2. Liquidity pool target position (0-25)
  if (target.price > price) buyScore += target.score * 0.25;
  else sellScore += target.score * 0.25;

  // 3. RSI extremes (0-20)
  if (rsi !== null) {
    if (rsi >= 70) sellScore += Math.min(20, (rsi - 70) * 1.4);
    else if (rsi <= 30) buyScore += Math.min(20, (30 - rsi) * 1.4);
  }

  // 4. Point of control position (0-15)
  if (kAnalysis.poc) {
    const pocDist = Math.abs(kAnalysis.poc.price - price) / price;
    if (pocDist < 0.01 && kAnalysis.poc.price < price) buyScore += 15;
    else if (pocDist < 0.01 && kAnalysis.poc.price > price) sellScore += 15;
  }

  // 5. Trend strength proxy (0-10)
  if (trendStrength >= 70) buyScore += 10;
  else if (trendStrength <= 30) sellScore += 10;

  const total = buyScore + sellScore || 1;
  buyScore = Math.round((buyScore / total) * 100);
  sellScore = Math.round((sellScore / total) * 100);

  if (buyScore > 65) {
    return { type: "BUY", score: buyScore, strength: buyScore > 80 ? "STRONG" : buyScore > 70 ? "MODERATE" : "WEAK" };
  }
  if (sellScore > 65) {
    return { type: "SELL", score: sellScore, strength: sellScore > 80 ? "STRONG" : sellScore > 70 ? "MODERATE" : "WEAK" };
  }
  return null;
}
