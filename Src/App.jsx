import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { ComposedChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid } from "recharts";
import { fetchQuotes, fetchCandles } from "./twelveData.js";
import {
  fmtPrice,
  fmtPct,
  timeAgo,
  findLiquidityPools,
  analyzeCandles,
  computeRSI,
  activeSessions,
  sessionOverlapStrength,
  generateSignal
} from "./analytics.js";

// Edit this list to change what shows up in the tab row. `symbol` must be
// a valid Twelve Data symbol - use https://twelvedata.com/symbol-search
// if a symbol below doesn't resolve for your account/plan.
export const SYMBOLS = [
  { symbol: "EUR/USD", label: "EURUSD" },
  { symbol: "GBP/USD", label: "GBPUSD" },
  { symbol: "USD/JPY", label: "USDJPY" },
  { symbol: "USD/CHF", label: "USDCHF" },
  { symbol: "AUD/USD", label: "AUDUSD" },
  { symbol: "XAU/USD", label: "GOLD" },
  { symbol: "XAG/USD", label: "SILVER" },
  { symbol: "WTI/USD", label: "OIL" },
  { symbol: "NDX", label: "NASDAQ" },
  { symbol: "DJI", label: "DOW 30" },
  { symbol: "SPX", label: "S&P 500" }
];

const INTERVALS = [
  { value: "1min", label: "1m" },
  { value: "5min", label: "5m" },
  { value: "15min", label: "15m" },
  { value: "1h", label: "1h" }
];

// Free Twelve Data tier = 800 calls/day, 8/min. One batched quote call for
// ALL symbols + one candle call for the active symbol, every REFRESH_MS.
// 30s -> ~2 calls/min, ~2,880/day if left open 24/7. Raise this if you're
// on a paid plan, or lower the symbol list if you're on free.
const REFRESH_MS = 30000;
const CHART_REFRESH_MS = 60000;

function fmtCompact(n) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1) + "K";
  return sign + abs.toFixed(0);
}

// ---------- data hook ----------
function useRadarData(symbol, interval) {
  const [quote, setQuote] = useState(null);
  const [allQuotes, setAllQuotes] = useState({});
  const [candles, setCandles] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(null);
  const visibleRef = useRef(true);

  useEffect(() => {
    const onVis = () => (visibleRef.current = document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const fetchAllQuotes = useCallback(async () => {
    if (!visibleRef.current) return;
    try {
      const symbols = SYMBOLS.map((s) => s.symbol);
      const data = await fetchQuotes(symbols);
      setAllQuotes(data);
      setError(null);
      setLastUpdate(new Date());
    } catch (e) {
      setError(e.message || "Failed to reach Twelve Data");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchChart = useCallback(async () => {
    if (!visibleRef.current) return;
    try {
      const data = await fetchCandles(symbol, interval, 90);
      setCandles(data);
    } catch (e) {
      // non-fatal, keep last good candles
    }
  }, [symbol, interval]);

  useEffect(() => {
    setLoading(true);
    fetchAllQuotes();
    fetchChart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  useEffect(() => {
    fetchChart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interval]);

  useEffect(() => {
    const id = setInterval(fetchAllQuotes, REFRESH_MS);
    return () => clearInterval(id);
  }, [fetchAllQuotes]);

  useEffect(() => {
    const id = setInterval(fetchChart, CHART_REFRESH_MS);
    return () => clearInterval(id);
  }, [fetchChart]);

  useEffect(() => {
    setQuote(allQuotes[symbol] || null);
  }, [allQuotes, symbol]);

  return { quote, allQuotes, candles, error, loading, lastUpdate };
}

// ---------- chart shapes ----------
const WickShape = (props) => {
  const { x, width, height, y, payload } = props;
  const fill = payload.isUp ? "#22c55e" : "#ef4444";
  return <rect x={x + width / 2 - 1} y={y} width={2} height={height} fill={fill} />;
};
const CandleBodyShape = (props) => {
  const { x, y, width, height, payload } = props;
  const fill = payload.isUp ? "#22c55e" : "#ef4444";
  return <rect x={x} y={y} width={width} height={Math.max(height, 1)} fill={fill} rx={1} />;
};
const CustomTooltip = ({ active, payload, label, symbol }) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    return (
      <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 12, padding: "10px 14px", fontSize: 12, color: "#cbd5e1", boxShadow: "0 10px 25px rgba(0,0,0,0.5)" }}>
        <div style={{ marginBottom: 6, color: "#94a3b8", fontWeight: 600 }}>{new Date(label).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <div>O: <span style={{ color: "#fff", fontWeight: 700 }}>{fmtPrice(data.open, symbol)}</span></div>
          <div>H: <span style={{ color: "#fff", fontWeight: 700 }}>{fmtPrice(data.high, symbol)}</span></div>
          <div>L: <span style={{ color: "#fff", fontWeight: 700 }}>{fmtPrice(data.low, symbol)}</span></div>
          <div>C: <span style={{ color: data.isUp ? "#22c55e" : "#ef4444", fontWeight: 700 }}>{fmtPrice(data.close, symbol)}</span></div>
        </div>
      </div>
    );
  }
  return null;
};

// ---------- small UI atoms ----------
function Card({ children, style }) {
  return <div style={{ ...styles.card, ...style }}>{children}</div>;
}
function CardLabel({ children, right }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
      <div style={styles.cardLabel}>{children}</div>
      {right && <div style={styles.cardLabelRight}>{right}</div>}
    </div>
  );
}
function BarGauge({ pct, color }) {
  return (
    <div style={styles.barTrack}>
      <div style={{ ...styles.barFill, width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} />
    </div>
  );
}
function Gauge({ value, label, sub }) {
  const clamped = Math.max(0, Math.min(100, value));
  const color = clamped >= 60 ? "#22c55e" : clamped >= 40 ? "#f5b301" : "#ef4444";
  const r = 34, circ = 2 * Math.PI * r;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <svg width="88" height="88" viewBox="0 0 88 88">
        <circle cx="44" cy="44" r={r} fill="none" stroke="#1e293b" strokeWidth="8" />
        <circle cx="44" cy="44" r={r} fill="none" stroke={color} strokeWidth="8" strokeDasharray={circ} strokeDashoffset={circ - (clamped / 100) * circ} strokeLinecap="round" transform="rotate(-90 44 44)" />
        <text x="44" y="40" textAnchor="middle" fontSize="22" fontWeight="800" fill={color}>{Math.round(clamped)}</text>
        <text x="44" y="58" textAnchor="middle" fontSize="9" fontWeight="700" fill={color} letterSpacing="1">{label}</text>
      </svg>
      <div style={{ fontSize: 13, color: "#94a3b8", lineHeight: 1.4 }}>{sub}</div>
    </div>
  );
}
function Stat({ label, value, color }) {
  return (
    <div style={styles.statCell}>
      <div style={styles.statLabel}>{label}</div>
      <div style={{ fontWeight: 800, color: color || "#f8fafc", fontSize: 15 }}>{value}</div>
    </div>
  );
}
function Row({ label, value, valueColor }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, fontSize: 14 }}>
      <span style={{ color: "#94a3b8", fontWeight: 500 }}>{label}</span>
      <span style={{ color: valueColor || "#fff", fontWeight: 700 }}>{value}</span>
    </div>
  );
}
function TrapRow({ label, value, color }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14 }}>
      <span style={{ width: 110, fontSize: 13, color: "#94a3b8", fontWeight: 600 }}>{label}</span>
      <div style={{ flex: 1 }}><BarGauge pct={value} color={color || "#ec4899"} /></div>
      <span style={{ width: 32, textAlign: "right", fontSize: 14, color: "#f8fafc", fontWeight: 700 }}>{value}</span>
    </div>
  );
}

function SignalDisplay({ signal }) {
  if (!signal) return null;
  const isBuy = signal.type === "BUY";
  const bgColor = isBuy ? "#0a2e1a" : "#2e0a0a";
  const borderColor = isBuy ? "#22c55e" : "#ef4444";
  const textColor = isBuy ? "#22c55e" : "#ef4444";
  return (
    <div style={{ ...styles.signalBox, background: bgColor, borderColor, boxShadow: `0 0 40px ${isBuy ? "rgba(34,197,94,0.4)" : "rgba(239,68,68,0.4)"}` }}>
      <style>{`
        @keyframes fxPulse { 0%,100% { box-shadow: 0 0 40px ${isBuy ? "rgba(34,197,94,0.4)" : "rgba(239,68,68,0.4)"}; } 50% { box-shadow: 0 0 60px ${isBuy ? "rgba(34,197,94,0.8)" : "rgba(239,68,68,0.8)"}; } }
        @keyframes fxBounce { 0%,100% { transform: scale(1); } 50% { transform: scale(1.05); } }
        .fx-signal-arrow { animation: fxBounce 1s infinite; }
      `}</style>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 12 }}>
        <div style={{ fontSize: 60, fontWeight: 900, color: textColor, lineHeight: 1 }}>
          <span className="fx-signal-arrow">{isBuy ? "↑" : "↓"}</span>
        </div>
        <div>
          <div style={{ fontSize: 44, fontWeight: 900, color: textColor, lineHeight: 1 }}>{signal.type}</div>
          <div style={{ fontSize: 14, color: textColor, fontWeight: 700, letterSpacing: 1, marginTop: 4 }}>{signal.strength} SIGNAL</div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ fontSize: 48, fontWeight: 800, color: textColor }}>{signal.score}</div>
        <div style={{ flex: 1 }}>
          <div style={{ height: 8, background: "#1e293b", borderRadius: 999, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${signal.score}%`, background: textColor, borderRadius: 999 }} />
          </div>
          <div style={{ fontSize: 11, color: textColor, marginTop: 4, fontWeight: 600 }}>Confidence Score</div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [symbol, setSymbol] = useState(SYMBOLS[0].symbol);
  const [interval, setIntervalStr] = useState("5min");
  const { quote, candles, error, loading, lastUpdate } = useRadarData(symbol, interval);

  useEffect(() => {
    document.body.style.backgroundColor = "#02040a";
    document.body.style.margin = "0";
    document.body.style.padding = "0";
    document.documentElement.style.backgroundColor = "#02040a";
  }, []);

  const price = quote ? parseFloat(quote.close) : null;
  const changePct = quote ? parseFloat(quote.percent_change) : null;
  const high = quote ? parseFloat(quote.high) : null;
  const low = quote ? parseFloat(quote.low) : null;
  const openPrice = quote ? parseFloat(quote.open) : null;
  const prevClose = quote ? parseFloat(quote.previous_close) : null;
  const marketOpen = quote ? quote.is_market_open : null;

  const kAnalysis = useMemo(() => analyzeCandles(candles), [candles]);
  const liquidity = useMemo(() => (candles && price ? findLiquidityPools(candles, price) : {}), [candles, price]);
  const { magnet, target, pools } = liquidity;

  const rsi = useMemo(() => computeRSI(candles, 14), [candles]);

  const biasLabel = kAnalysis ? (kAnalysis.buyPct >= 50 ? "BULLISH" : "BEARISH") : null;
  const confidence =
    kAnalysis && target ? Math.round(Math.min(99, Math.max(1, Math.abs(kAnalysis.buyPct - 50) * 1.4 + (target.score || 0) * 0.3))) : null;

  // Trend strength proxy: distance of price from the simple mean of the
  // visible candles, scaled 0-100 (used in place of a funding rate).
  const trendStrength = useMemo(() => {
    if (!candles || candles.length < 5) return 50;
    const mean = candles.reduce((s, c) => s + c.close, 0) / candles.length;
    const dist = (candles[candles.length - 1].close - mean) / mean;
    return Math.round(Math.min(100, Math.max(0, 50 + dist * 4000)));
  }, [candles]);
  const strengthLabel = trendStrength >= 65 ? "STRONG" : trendStrength >= 40 ? "MODERATE" : "WEAK";
  const strengthSub = trendStrength >= 65 ? "Trend has conviction." : trendStrength >= 40 ? "Mixed signals — monitor closely." : "Fading momentum / ranging.";

  const overbought = rsi !== null ? Math.round(Math.max(0, Math.min(100, (rsi - 50) * 2))) : 0;
  const oversold = rsi !== null ? Math.round(Math.max(0, Math.min(100, (50 - rsi) * 2))) : 0;
  const bullTrap = kAnalysis && kAnalysis.sweep && kAnalysis.sweep.type === "bearish" ? kAnalysis.sweep.confidence : 0;
  const bearTrap = kAnalysis && kAnalysis.sweep && kAnalysis.sweep.type === "bullish" ? kAnalysis.sweep.confidence : 0;

  const sessions = useMemo(() => activeSessions(), [lastUpdate]);
  const sessionStrength = useMemo(() => sessionOverlapStrength(sessions), [sessions]);

  const signal = useMemo(() => {
    if (!kAnalysis || !target || price === null) return null;
    return generateSignal(kAnalysis, target, price, rsi, trendStrength);
  }, [kAnalysis, target, price, rsi, trendStrength]);

  const chartData = useMemo(() => {
    if (!candles) return [];
    return candles.map((c) => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      candle: [c.open, c.close].sort((a, b) => a - b),
      wick: [c.low, c.high],
      isUp: c.close >= c.open
    }));
  }, [candles]);

  const activeLabel = SYMBOLS.find((s) => s.symbol === symbol)?.label || symbol;

  return (
    <div style={styles.pageWrapper}>
      <div style={styles.app}>
        <div style={styles.header}>
          <div>
            <div style={styles.title}>
              FX <span style={styles.titleAccent}>Liquidity Radar.</span>
            </div>
            <div style={styles.subtitle}>{activeLabel} &nbsp;·&nbsp; {symbol.includes("/") ? "FOREX" : symbol === "XAU/USD" || symbol === "XAG/USD" || symbol === "WTI/USD" ? "COMMODITY" : "INDEX"}</div>
          </div>
          <div style={{ ...styles.livePill, ...(marketOpen === false ? styles.closedPill : {}) }}>
            <span style={{ ...styles.liveDot, background: marketOpen === false ? "#64748b" : "#22c55e", boxShadow: marketOpen === false ? "none" : "0 0 8px #22c55e" }} />
            {marketOpen === false ? "CLOSED" : "LIVE"}
          </div>
        </div>

        <div style={styles.hr} />

        <div style={styles.tabRow}>
          {SYMBOLS.map((s) => (
            <div key={s.symbol} onClick={() => setSymbol(s.symbol)} style={{ ...styles.tab, ...(symbol === s.symbol ? styles.tabActive : {}) }}>
              {s.label}
            </div>
          ))}
        </div>

        {error && <div style={styles.errorBox}>Connection error: {error}. Retrying…</div>}

        {signal && (
          <div style={{ marginBottom: 20 }}>
            <SignalDisplay signal={signal} />
          </div>
        )}

        <div style={styles.statsRow}>
          <Stat label="RSI(14)" value={rsi !== null ? rsi.toFixed(1) : "—"} color={rsi >= 70 ? "#ef4444" : rsi <= 30 ? "#22c55e" : undefined} />
          <Stat label="Open" value={openPrice ? fmtPrice(openPrice, symbol) : "—"} />
          <Stat label="Prev Close" value={prevClose ? fmtPrice(prevClose, symbol) : "—"} />
          <Stat label="Session" value={sessionStrength.label} color="#38bdf8" />
        </div>

        <Card style={styles.priceCard}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={styles.priceText}>{price !== null ? fmtPrice(price, symbol) : "Loading…"}</div>
              <div style={styles.priceChangeWrapper}>
                <span style={{ color: changePct >= 0 ? "#22c55e" : "#ef4444", fontWeight: 700 }}>{changePct !== null && !isNaN(changePct) ? fmtPct(changePct) : ""}</span>
              </div>
            </div>
            <div style={{ textAlign: "right", marginTop: 4 }}>
              <div style={{ color: "#38bdf8", fontSize: 38, fontWeight: 800, lineHeight: 1 }}>{confidence ?? "—"}</div>
              <div style={styles.smallLabel}>CONFIDENCE</div>
            </div>
          </div>
          <div style={styles.priceSubRow}>
            <span>High: <b style={{ color: "#fff" }}>{high ? fmtPrice(high, symbol) : "—"}</b></span>
            <span>Low: <b style={{ color: "#fff" }}>{low ? fmtPrice(low, symbol) : "—"}</b></span>
            <span>Trend: <b style={{ color: "#fff" }}>{strengthLabel}</b></span>
          </div>
        </Card>

        <Card style={{ padding: "20px 16px" }}>
          <CardLabel
            right={
              <div style={{ display: "flex", gap: 6 }}>
                {INTERVALS.map((iv) => (
                  <span key={iv.value} onClick={() => setIntervalStr(iv.value)} style={{ ...styles.ivPill, ...(interval === iv.value ? styles.ivPillActive : {}) }}>
                    {iv.label}
                  </span>
                ))}
              </div>
            }
          >
            PRICE CHART
          </CardLabel>
          <div style={{ height: 180, marginTop: 12, marginLeft: -12 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData}>
                <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="time" tickFormatter={(t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} stroke="#64748b" fontSize={10} minTickGap={30} tickLine={false} axisLine={false} dy={10} />
                <YAxis domain={["auto", "auto"]} stroke="#64748b" fontSize={10} width={54} tickFormatter={(v) => fmtCompact(v)} tickLine={false} axisLine={false} />
                <Tooltip content={<CustomTooltip symbol={symbol} />} cursor={{ stroke: "#334155", strokeWidth: 1, strokeDasharray: "4 4" }} />
                <Bar dataKey="wick" shape={<WickShape />} isAnimationActive={false} />
                <Bar dataKey="candle" shape={<CandleBodyShape />} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card>
          <CardLabel>MARKET BIAS</CardLabel>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: -4 }}>
            <div style={{ color: biasLabel === "BULLISH" ? "#22c55e" : "#ec4899", fontWeight: 800, fontSize: 22 }}>{biasLabel ?? "—"}</div>
            <div style={{ color: "#94a3b8", fontWeight: 600 }}>{kAnalysis ? `${kAnalysis.buyPct.toFixed(1)}/100` : "—"}</div>
          </div>
          <BarGauge pct={kAnalysis ? kAnalysis.buyPct : 0} color={biasLabel === "BULLISH" ? "#22c55e" : "#ec4899"} />
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 13 }}>
            <span style={{ color: "#22c55e", fontWeight: 700 }}>{kAnalysis ? kAnalysis.buyPct.toFixed(1) : "—"}% BULLISH CANDLES</span>
            <span style={{ color: "#ec4899", fontWeight: 700 }}>{kAnalysis ? kAnalysis.sellPct.toFixed(1) : "—"}% BEARISH</span>
          </div>
        </Card>

        <div style={styles.twoCol}>
          <Card style={{ padding: "16px 14px" }}>
            <CardLabel>MAGNET POOL</CardLabel>
            <div style={{ color: "#38bdf8", fontSize: 22, fontWeight: 800, marginTop: 4 }}>{magnet ? fmtPrice(magnet.price, symbol) : "—"}</div>
            <div style={styles.cardHint}>Strongest swing liquidity cluster</div>
            <Row label="Dist" value={magnet && price ? `${(Math.abs(magnet.price - price) / price * 100).toFixed(2)}%` : "—"} valueColor="#22c55e" />
            <Row label="Touches" value={magnet ? magnet.touches : "—"} />
          </Card>
          <Card style={{ padding: "16px 14px" }}>
            <CardLabel>TARGET POOL</CardLabel>
            <div style={{ color: "#f5b301", fontSize: 22, fontWeight: 800, marginTop: 4 }}>{target ? fmtPrice(target.price, symbol) : "—"}</div>
            <div style={styles.cardHint}>Structure + bias</div>
            <Row label="Score" value={target ? `${target.score}/100` : "—"} valueColor="#f5b301" />
            <Row label="Type" value={target && price ? (target.price > price ? "Resistance" : "Support") : "—"} valueColor="#f5b301" />
          </Card>
        </div>

        <Card>
          <CardLabel>TREND STRENGTH</CardLabel>
          <div style={{ marginTop: 8 }}>
            <Gauge value={trendStrength} label={strengthLabel} sub={strengthSub} />
          </div>
        </Card>

        <Card>
          <CardLabel>REVERSAL &amp; RSI RISK</CardLabel>
          <TrapRow label="Bull Trap" value={bullTrap} />
          <TrapRow label="Bear Trap" value={bearTrap} />
          <TrapRow label="Overbought" value={overbought} color="#ef4444" />
          <TrapRow label="Oversold" value={oversold} color="#22c55e" />
        </Card>

        <Card>
          <CardLabel right={<span style={{ fontSize: 11, color: "#64748b" }}>UTC {new Date().getUTCHours()}:00</span>}>TRADING SESSIONS</CardLabel>
          <div style={{ display: "flex", gap: 8, marginTop: 4, marginBottom: 12 }}>
            {sessions.map((s) => (
              <div key={s.name} style={{ flex: 1, textAlign: "center", padding: "8px 4px", borderRadius: 10, background: s.active ? "rgba(34,197,94,0.12)" : "#0f172a", border: `1px solid ${s.active ? "rgba(34,197,94,0.4)" : "#1e293b"}` }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: s.active ? "#22c55e" : "#64748b" }}>{s.name}</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 13, color: "#94a3b8", lineHeight: 1.4 }}>
            <b style={{ color: "#38bdf8" }}>{sessionStrength.label} LIQUIDITY</b> — {sessionStrength.note}
          </div>
        </Card>

        <Card>
          <CardLabel right={<span style={{ fontSize: 11, color: "#64748b" }}>AMBER = MAGNET</span>}>LIQUIDITY POOL MAP</CardLabel>
          <div style={{ marginTop: 8 }}>
            {(pools || [])
              .slice()
              .sort((a, b) => b.price - a.price)
              .map((z, i) => {
                const maxTouches = Math.max(...(pools || []).map((x) => x.touches), 1);
                const isWall = magnet && z.price === magnet.price;
                return (
                  <div key={i} style={styles.heatRow}>
                    <span style={{ width: 86, fontSize: 13, color: price && Math.abs(z.price - price) < (liquidity.bucketSize || 1) ? "#38bdf8" : "#94a3b8", fontWeight: 600 }}>
                      {fmtPrice(z.price, symbol)}
                    </span>
                    <div style={{ ...styles.heatBar, width: `${(z.touches / maxTouches) * 100}%`, background: isWall ? "#f5b301" : z.poolSide === "ask" ? "rgba(236,72,153,0.3)" : "rgba(34,197,94,0.3)" }}>
                      {isWall && <span style={{ fontSize: 11, color: "#02040a", fontWeight: 800, padding: "0 8px" }}>{z.touches}× TESTED</span>}
                    </div>
                  </div>
                );
              })}
            {(!pools || pools.length === 0) && <div style={{ fontSize: 13, color: "#64748b" }}>Not enough candle history yet to map liquidity pools.</div>}
          </div>
        </Card>

        <div style={styles.footer}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, marginBottom: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: loading ? "#f5b301" : "#22c55e" }} />
            {loading ? "Connecting to Twelve Data…" : lastUpdate ? `Updated ${timeAgo(lastUpdate.getTime())}` : ""}
          </div>
          <div style={{ opacity: 0.5, lineHeight: 1.5 }}>
            Liquidity pools are computed from swing highs/lows in price history, not a real order book —
            OTC forex/futures have no public depth feed. Signals are structural estimates, not financial advice.
          </div>
        </div>
      </div>
    </div>
  );
}

const styles = {
  pageWrapper: { background: "#02040a", minHeight: "100vh", width: "100%" },
  app: { background: "#02040a", color: "#e2e8f0", fontFamily: "'Inter', -apple-system, sans-serif", padding: "20px 16px 40px", maxWidth: 480, margin: "0 auto", boxSizing: "border-box" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginTop: 8 },
  title: { fontSize: 30, fontWeight: 800, color: "#fff", lineHeight: 1.1, letterSpacing: "-0.02em" },
  titleAccent: { color: "#f5b301" },
  subtitle: { fontSize: 11, letterSpacing: 1.5, color: "#64748b", marginTop: 8, fontWeight: 600, textTransform: "uppercase" },
  livePill: { border: "1px solid rgba(34,197,94,0.3)", background: "rgba(34,197,94,0.1)", color: "#22c55e", borderRadius: 999, padding: "6px 12px", fontSize: 12, fontWeight: 800, display: "flex", alignItems: "center", gap: 6, height: "fit-content" },
  closedPill: { border: "1px solid #334155", background: "#0f172a", color: "#64748b" },
  liveDot: { width: 8, height: 8, borderRadius: "50%", display: "inline-block" },
  hr: { height: 1, background: "linear-gradient(90deg, #1e293b, transparent)", marginTop: 20, marginBottom: 18 },
  tabRow: { display: "flex", gap: 8, overflowX: "auto", paddingBottom: 16, marginBottom: 6, msOverflowStyle: "none", scrollbarWidth: "none" },
  tab: { flexShrink: 0, padding: "8px 18px", borderRadius: 999, border: "1px solid #1e293b", color: "#94a3b8", fontSize: 13, fontWeight: 700, cursor: "pointer", transition: "all 0.2s" },
  tabActive: { background: "#f5b301", color: "#02040a", borderColor: "#f5b301", boxShadow: "0 4px 12px rgba(245,179,1,0.2)" },
  errorBox: { background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", color: "#fca5a5", borderRadius: 12, padding: "12px 16px", fontSize: 13, marginBottom: 20, fontWeight: 600 },
  statsRow: { display: "flex", justifyContent: "space-between", background: "#0a0e17", border: "1px solid #1e293b", borderRadius: 20, padding: "18px 12px", marginBottom: 20, boxShadow: "0 4px 20px rgba(0,0,0,0.2)" },
  statCell: { textAlign: "center", flex: 1 },
  statLabel: { fontSize: 11, color: "#64748b", marginBottom: 6, fontWeight: 600, textTransform: "uppercase" },
  priceCard: { border: "1px solid rgba(34,197,94,0.3)", background: "linear-gradient(180deg, #0a1410 0%, #050a08 100%)", boxShadow: "0 8px 32px rgba(34,197,94,0.05)" },
  priceText: { fontSize: 34, fontWeight: 800, color: "#fff", letterSpacing: "-0.02em" },
  priceChangeWrapper: { marginTop: 6, fontSize: 15 },
  smallLabel: { fontSize: 11, color: "#64748b", letterSpacing: 1, fontWeight: 700, marginTop: 4 },
  priceSubRow: { display: "flex", justifyContent: "space-between", marginTop: 20, fontSize: 13, color: "#94a3b8" },
  card: { background: "#0a0e17", border: "1px solid #1e293b", borderRadius: 24, padding: "20px", marginBottom: 20, boxShadow: "0 4px 20px rgba(0,0,0,0.2)" },
  cardLabel: { fontSize: 11, letterSpacing: 1.5, color: "#64748b", fontWeight: 800, textTransform: "uppercase" },
  cardLabelRight: { fontSize: 11, fontWeight: 600 },
  barTrack: { height: 10, background: "#1e293b", borderRadius: 999, marginTop: 12, overflow: "hidden" },
  barFill: { height: "100%", borderRadius: 999, transition: "width 0.5s cubic-bezier(0.4,0,0.2,1)" },
  twoCol: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 20 },
  cardHint: { fontSize: 13, color: "#64748b", marginTop: 6, lineHeight: 1.5, fontWeight: 500 },
  heatRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 8 },
  heatBar: { height: 26, borderRadius: 6, display: "flex", alignItems: "center", minWidth: 6, transition: "width 0.3s ease" },
  ivPill: { fontSize: 11, color: "#64748b", padding: "4px 10px", borderRadius: 8, border: "1px solid #1e293b", fontWeight: 600, cursor: "pointer", transition: "all 0.2s" },
  ivPillActive: { color: "#02040a", background: "#f5b301", borderColor: "#f5b301", fontWeight: 800 },
  signalBox: { border: "2px solid", borderRadius: 24, padding: "24px", marginBottom: 20, background: "#0a0e17" },
  footer: { textAlign: "center", fontSize: 12, color: "#475569", marginTop: 32 }
};
