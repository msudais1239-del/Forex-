// Thin client for the Twelve Data REST API (https://twelvedata.com/docs).
// Free tier: 800 requests/day, 8 requests/minute. This module batches
// symbols into single calls and lets the caller control poll frequency,
// so a sensible default (see App.jsx REFRESH_MS) stays well inside that.

const BASE = "https://api.twelvedata.com";

function getApiKey() {
  const key = import.meta.env.VITE_TWELVE_DATA_API_KEY;
  if (!key) {
    throw new Error(
      "Missing VITE_TWELVE_DATA_API_KEY. Copy .env.example to .env and add your free Twelve Data API key."
    );
  }
  return key;
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Twelve Data request failed (${res.status})`);
  const data = await res.json();
  if (data && data.status === "error") {
    throw new Error(data.message || "Twelve Data returned an error");
  }
  return data;
}

// Fetch real-time quotes for many symbols in ONE API call.
// Returns a map: { "EUR/USD": {...quote}, "XAU/USD": {...quote}, ... }
export async function fetchQuotes(symbols) {
  const apikey = getApiKey();
  const symbolParam = symbols.join(",");
  const url = `${BASE}/quote?symbol=${encodeURIComponent(symbolParam)}&apikey=${apikey}`;
  const data = await getJson(url);

  // Twelve Data returns a single object (not keyed) when only one symbol
  // is requested, and an object-of-objects keyed by symbol for multiple.
  if (symbols.length === 1) {
    return { [symbols[0]]: data };
  }
  return data;
}

// Fetch OHLC candles for a single symbol/interval.
// interval: "1min" | "5min" | "15min" | "1h" | "1day" ...
// Returns an array of candles oldest -> newest:
// { time, open, high, low, close, volume }
export async function fetchCandles(symbol, interval, outputsize = 90) {
  const apikey = getApiKey();
  const url = `${BASE}/time_series?symbol=${encodeURIComponent(
    symbol
  )}&interval=${interval}&outputsize=${outputsize}&apikey=${apikey}`;
  const data = await getJson(url);
  if (!data.values) return [];

  return data.values
    .map((v) => ({
      time: new Date(v.datetime.replace(" ", "T")).getTime(),
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
      volume: v.volume ? parseFloat(v.volume) : 0
    }))
    .filter((c) => !isNaN(c.close))
    .sort((a, b) => a.time - b.time);
}
