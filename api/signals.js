/**
 * api/signals.js
 * SCALP (Futuros 5m): ICT/SMC — Liquidity Sweep + Order Block + EMA 9/21 + VWAP + ATR
 *   Fuente: Bybit Futures → Binance Spot fallback → KuCoin (todos públicos, sin key)
 * SPOT: Weinstein Stage + EMA 20/50/200 + RSI + Fibonacci + Proyección precio
 *   Fuente: CoinGecko (cripto) + Yahoo Finance (acciones/ETFs)
 */

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { ticker, mode } = req.body || {};
  if (!ticker) return res.status(400).json({ error: 'Ticker requerido' });

  try {
    if (mode === 'scalp') {
      return res.status(200).json(await analyzeScalp(ticker.toUpperCase()));
    } else {
      return res.status(200).json(await analyzeSpot(ticker.toUpperCase()));
    }
  } catch (err) {
    console.error('Signals error:', err);
    return res.status(500).json({ error: String(err), ticker });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DATA SOURCES — múltiples fuentes con fallback
// ─────────────────────────────────────────────────────────────────────────────

async function fetchKlines(sym, interval, limit) {
  const pair = sym.endsWith('USDT') ? sym : `${sym}USDT`;

  // 1. Bybit Futures (no restringe IPs de cloud)
  try {
    const bybitInterval = { '5m': '5', '15m': '15', '1h': '60', '1d': 'D' }[interval] || '5';
    const r = await fetch(
      `https://api.bybit.com/v5/market/kline?category=linear&symbol=${pair}&interval=${bybitInterval}&limit=${limit}`
    );
    if (r.ok) {
      const d = await r.json();
      const list = d?.result?.list;
      if (list && list.length > 10) {
        // Bybit devuelve orden inverso (más reciente primero)
        return list.reverse().map(k => ({
          time: Number(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
          low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
        }));
      }
    }
  } catch {}

  // 2. Binance Spot (más permisivo que Futures para IPs cloud)
  try {
    const binInterval = interval; // 5m, 15m, etc.
    const r = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${binInterval}&limit=${limit}`
    );
    if (r.ok) {
      const d = await r.json();
      if (Array.isArray(d) && d.length > 10) {
        return d.map(k => ({
          time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
          low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
        }));
      }
    }
  } catch {}

  // 3. KuCoin como último fallback
  try {
    const kuInterval = { '5m': '5min', '15m': '15min', '1h': '1hour', '1d': '1day' }[interval] || '5min';
    const endAt = Math.floor(Date.now() / 1000);
    const startAt = endAt - limit * 300;
    const r = await fetch(
      `https://api.kucoin.com/api/v1/market/candles?type=${kuInterval}&symbol=${sym}-USDT&startAt=${startAt}&endAt=${endAt}`
    );
    if (r.ok) {
      const d = await r.json();
      const data = d?.data;
      if (data && data.length > 10) {
        return data.reverse().map(k => ({
          time: Number(k[0]) * 1000, open: parseFloat(k[1]), close: parseFloat(k[2]),
          high: parseFloat(k[3]), low: parseFloat(k[4]), volume: parseFloat(k[5]),
        }));
      }
    }
  } catch {}

  return null;
}

async function fetchCGHistory(id, days = 365) {
  try {
    const r = await fetch(
      `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${days}&interval=daily`
    );
    if (!r.ok) return null;
    const d = await r.json();
    const prices = d.prices || [], vols = d.total_volumes || [];
    return prices.map((p, i) => ({
      date: new Date(p[0]).toISOString().split('T')[0],
      close: p[1], high: p[1], low: p[1], volume: vols[i]?.[1] || 0,
    }));
  } catch { return null; }
}

async function fetchYahooHistory(sym) {
  for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const r = await fetch(`${base}/v8/finance/chart/${sym}?interval=1d&range=1y`);
      if (!r.ok) continue;
      const d = await r.json();
      const result = d?.chart?.result?.[0];
      if (!result) continue;
      const ts = result.timestamp || [], q = result.indicators?.quote?.[0] || {};
      return ts.map((t, i) => ({
        date: new Date(t * 1000).toISOString().split('T')[0],
        close: q.close?.[i], high: q.high?.[i] || q.close?.[i],
        low: q.low?.[i] || q.close?.[i], volume: q.volume?.[i] || 0,
      })).filter(b => b.close != null);
    } catch { continue; }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// INDICADORES
// ─────────────────────────────────────────────────────────────────────────────

function ema(data, period) {
  const k = 2 / (period + 1);
  const result = [];
  let prev = null;
  for (let i = 0; i < data.length; i++) {
    if (prev === null) {
      if (i < period - 1) { result.push(null); continue; }
      prev = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
      result.push(prev); continue;
    }
    prev = data[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

function rsi(closes, period = 14) {
  const result = new Array(period).fill(null);
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) ag += d; else al += Math.abs(d);
  }
  ag /= period; al /= period;
  for (let i = period; i < closes.length; i++) {
    if (i > period) {
      const d = closes[i] - closes[i - 1];
      ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
      al = (al * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
    }
    result.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return result;
}

function atr(highs, lows, closes, period = 14) {
  const trs = highs.map((h, i) => {
    if (i === 0) return h - lows[i];
    return Math.max(h - lows[i], Math.abs(h - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
  });
  return sma(trs, period);
}

function sma(data, period) {
  return data.map((_, i) => {
    if (i < period - 1) return null;
    const sl = data.slice(i - period + 1, i + 1).filter(v => v != null);
    return sl.length === period ? sl.reduce((a, b) => a + b, 0) / period : null;
  });
}

function calcVWAP(bars) {
  let cumTPV = 0, cumVol = 0;
  for (const b of bars) {
    const tp = (b.high + b.low + b.close) / 3;
    cumTPV += tp * b.volume; cumVol += b.volume;
  }
  return cumVol > 0 ? cumTPV / cumVol : bars[bars.length - 1].close;
}

// Fibonacci retracements desde swing high/low
function fibonacci(high, low) {
  const diff = high - low;
  return {
    ext_1618: high + diff * 0.618,
    ext_1000: high,
    r_000:    high,
    r_236:    high - diff * 0.236,
    r_382:    high - diff * 0.382,
    r_500:    high - diff * 0.5,
    r_618:    high - diff * 0.618,
    r_786:    high - diff * 0.786,
    r_1000:   low,
    ext_neg:  low - diff * 0.272,
  };
}

// Proyección lineal de tendencia (regresión lineal simple)
function linearRegression(closes, periods) {
  const n = closes.length;
  const xMean = (n - 1) / 2;
  const yMean = closes.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (closes[i] - yMean);
    den += (i - xMean) ** 2;
  }
  const slope = den !== 0 ? num / den : 0;
  const intercept = yMean - slope * xMean;
  return {
    slope,
    currentFit: intercept + slope * (n - 1),
    projections: periods.map(p => ({
      period: p,
      price: intercept + slope * (n - 1 + p),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SCALPING — ICT/Smart Money Concepts
// ─────────────────────────────────────────────────────────────────────────────

async function analyzeScalp(sym) {
  const [bars5m, bars15m] = await Promise.all([
    fetchKlines(sym, '5m', 120),
    fetchKlines(sym, '15m', 60),
  ]);

  if (!bars5m || bars5m.length < 50) {
    return {
      error: `No se encontraron datos para ${sym}. Asegurate de escribir solo el símbolo base (BTC, ETH, SOL, BNB, XRP, DOGE, AVAX, LINK, DOT, MATIC, etc.)`,
      ticker: sym
    };
  }

  const closes5  = bars5m.map(b => b.close);
  const highs5   = bars5m.map(b => b.high);
  const lows5    = bars5m.map(b => b.low);
  const volumes5 = bars5m.map(b => b.volume);
  const n = closes5.length;
  const cur = closes5[n - 1];

  const ema9   = ema(closes5, 9);
  const ema21  = ema(closes5, 21);
  const atr14  = atr(highs5, lows5, closes5, 14);
  const rsi14  = rsi(closes5, 14);
  const vwap   = calcVWAP(bars5m.slice(-50));

  const e9 = ema9[n-1], e21 = ema21[n-1];
  const atrCur = atr14[n-1] || (cur * 0.005);
  const rsiCur = rsi14[n-1], rsiPrev = rsi14[n-2];

  // Swing highs/lows recientes (últimas 30 velas)
  const lookback = Math.min(30, n - 2);
  const recentHigh = Math.max(...highs5.slice(n - lookback - 1, n - 1));
  const recentLow  = Math.min(...lows5.slice(n - lookback - 1, n - 1));

  const lastBar  = bars5m[n - 1];
  const prevBar  = bars5m[n - 2];

  // Liquidity Sweep
  const bullSweep = lastBar.low < recentLow && lastBar.close > recentLow && lastBar.close > lastBar.open;
  const bearSweep = lastBar.high > recentHigh && lastBar.close < recentHigh && lastBar.close < lastBar.open;

  // Order Blocks
  let bullOB = null, bearOB = null;
  for (let i = n - 3; i > Math.max(n - 25, 0); i--) {
    const b = bars5m[i], next3Avg = (closes5[i+1] + closes5[Math.min(i+2,n-1)] + closes5[Math.min(i+3,n-1)]) / 3;
    if (!bullOB && b.close < b.open && next3Avg > b.open * 1.002) {
      bullOB = { high: b.open, low: b.close, mid: (b.open + b.close) / 2 };
    }
    if (!bearOB && b.close > b.open && next3Avg < b.open * 0.998) {
      bearOB = { high: b.close, low: b.open, mid: (b.open + b.close) / 2 };
    }
    if (bullOB && bearOB) break;
  }

  // Fair Value Gap (FVG) — gap entre vela i-1 y vela i+1
  let bullFVG = null, bearFVG = null;
  for (let i = n - 3; i > Math.max(n - 15, 1); i--) {
    if (!bullFVG && lows5[i+1] > highs5[i-1]) {
      bullFVG = { low: highs5[i-1], high: lows5[i+1] };
    }
    if (!bearFVG && highs5[i+1] < lows5[i-1]) {
      bearFVG = { high: lows5[i-1], low: highs5[i+1] };
    }
    if (bullFVG && bearFVG) break;
  }

  const signals = [];
  let score = 0;

  // EMA trend
  if (e9 && e21) {
    if (cur > e9 && e9 > e21) {
      signals.push({ icon: '📈', text: `Tendencia alcista en 5m: precio > EMA9 (${e9.toFixed(4)}) > EMA21 (${e21.toFixed(4)})`, bull: true });
      score += 2;
    } else if (cur < e9 && e9 < e21) {
      signals.push({ icon: '📉', text: `Tendencia bajista en 5m: precio < EMA9 (${e9.toFixed(4)}) < EMA21 (${e21.toFixed(4)})`, bull: false });
      score -= 2;
    } else {
      signals.push({ icon: '↔️', text: `EMAs cruzadas — zona de indecisión, esperar definición`, bull: null });
    }
  }

  // VWAP
  if (cur > vwap) {
    signals.push({ icon: '🏦', text: `Sobre VWAP ($${vwap.toFixed(4)}) — instituciones compradoras`, bull: true }); score += 1;
  } else {
    signals.push({ icon: '🏦', text: `Bajo VWAP ($${vwap.toFixed(4)}) — instituciones vendedoras`, bull: false }); score -= 1;
  }

  // Liquidity Sweep
  if (bullSweep) {
    signals.push({ icon: '🌊', text: `Liquidity Sweep alcista — barrió stops en $${recentLow.toFixed(4)} y cerró arriba. Señal de acumulación institucional`, bull: true }); score += 3;
  } else if (bearSweep) {
    signals.push({ icon: '🌊', text: `Liquidity Sweep bajista — barrió stops en $${recentHigh.toFixed(4)} y cerró abajo. Señal de distribución institucional`, bull: false }); score -= 3;
  }

  // Order Block
  if (bullOB && cur >= bullOB.low * 0.999 && cur <= bullOB.high * 1.003) {
    signals.push({ icon: '📦', text: `Precio en Order Block alcista ($${bullOB.low.toFixed(4)}-$${bullOB.high.toFixed(4)}) — zona de demanda institucional`, bull: true }); score += 2;
  }
  if (bearOB && cur >= bearOB.low * 0.997 && cur <= bearOB.high * 1.001) {
    signals.push({ icon: '📦', text: `Precio en Order Block bajista ($${bearOB.low.toFixed(4)}-$${bearOB.high.toFixed(4)}) — zona de oferta institucional`, bull: false }); score -= 2;
  }

  // FVG
  if (bullFVG && cur >= bullFVG.low && cur <= bullFVG.high) {
    signals.push({ icon: '🕳️', text: `Fair Value Gap alcista ($${bullFVG.low.toFixed(4)}-$${bullFVG.high.toFixed(4)}) — imbalance, probable relleno al alza`, bull: true }); score += 1;
  }
  if (bearFVG && cur >= bearFVG.low && cur <= bearFVG.high) {
    signals.push({ icon: '🕳️', text: `Fair Value Gap bajista ($${bearFVG.low.toFixed(4)}-$${bearFVG.high.toFixed(4)}) — imbalance, probable relleno a la baja`, bull: false }); score -= 1;
  }

  // RSI
  if (rsiCur < 35 && rsiCur > rsiPrev) {
    signals.push({ icon: '⚡', text: `RSI ${rsiCur.toFixed(1)} — sobreventa con recuperación, momentum alcista`, bull: true }); score += 2;
  } else if (rsiCur > 65 && rsiCur < rsiPrev) {
    signals.push({ icon: '⚡', text: `RSI ${rsiCur.toFixed(1)} — sobrecompra con debilitamiento, momentum bajista`, bull: false }); score -= 2;
  } else if (rsiCur > 50) {
    signals.push({ icon: '📊', text: `RSI ${rsiCur.toFixed(1)} — zona de fuerza (>50)`, bull: true }); score += 1;
  } else {
    signals.push({ icon: '📊', text: `RSI ${rsiCur.toFixed(1)} — zona de debilidad (<50)`, bull: false }); score -= 1;
  }

  // Contexto 15m
  if (bars15m && bars15m.length >= 21) {
    const c15 = bars15m.map(b => b.close);
    const e21_15 = ema(c15, 21);
    const cur15 = c15[c15.length - 1], e21cur = e21_15[e21_15.length - 1];
    if (cur15 > e21cur) {
      signals.push({ icon: '🕰️', text: `Contexto 15m alcista — precio sobre EMA21 en timeframe superior (confluencia)`, bull: true }); score += 1;
    } else {
      signals.push({ icon: '🕰️', text: `Contexto 15m bajista — precio bajo EMA21 (divergencia con 5m)`, bull: false }); score -= 1;
    }
  }

  // Dirección y TP/SL/Leverage
  let direction = 'NEUTRAL';
  if (score >= 4) direction = 'LONG';
  else if (score <= -4) direction = 'SHORT';

  let entry = cur, tp = null, sl = null, leverage = null, rr = null;
  if (direction === 'LONG') {
    entry = bullOB ? Math.max(bullOB.high, e9 || cur) : cur;
    entry = Math.min(entry, cur * 1.002);
    sl = entry - atrCur * 1.2;
    tp = entry + atrCur * 2.2;
    rr = +((tp - entry) / (entry - sl)).toFixed(2);
  } else if (direction === 'SHORT') {
    entry = bearOB ? Math.min(bearOB.low, e9 || cur) : cur;
    entry = Math.max(entry, cur * 0.998);
    sl = entry + atrCur * 1.2;
    tp = entry - atrCur * 2.2;
    rr = +((entry - tp) / (sl - entry)).toFixed(2);
  }

  // Leverage basado en ATR%
  const atrPct = (atrCur / cur) * 100;
  leverage = atrPct > 4 ? 3 : atrPct > 2.5 ? 5 : atrPct > 1.5 ? 8 : atrPct > 0.8 ? 12 : atrPct > 0.4 ? 15 : 20;

  let verdict, verdictColor, verdictIcon;
  if (direction === 'LONG')    { verdict = 'LONG';    verdictColor = '#22c55e'; verdictIcon = '🟢'; }
  else if (direction === 'SHORT') { verdict = 'SHORT'; verdictColor = '#ef4444'; verdictIcon = '🔴'; }
  else                         { verdict = 'NEUTRAL'; verdictColor = '#eab308'; verdictIcon = '⚖️'; }

  return {
    ticker: sym, pair: `${sym}USDT`, mode: 'scalp',
    currentPrice: cur, verdict, verdictColor, verdictIcon, score, direction,
    entry: entry ? +entry.toFixed(6) : null,
    tp: tp ? +tp.toFixed(6) : null,
    sl: sl ? +sl.toFixed(6) : null,
    leverage, rr,
    atr: +atrCur.toFixed(6),
    rsi: rsiCur ? +rsiCur.toFixed(1) : null,
    ema9: e9 ? +e9.toFixed(6) : null,
    ema21: e21 ? +e21.toFixed(6) : null,
    vwap: +vwap.toFixed(6),
    bullSweep, bearSweep, bullOB, bearOB, bullFVG, bearFVG,
    signals, timeframe: '5m',
    analyzedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SPOT — Weinstein + EMA + RSI + Fibonacci + Predicciones
// ─────────────────────────────────────────────────────────────────────────────

const CGIDS = {
  BTC:'bitcoin',ETH:'ethereum',SOL:'solana',ADA:'cardano',DOT:'polkadot',
  AVAX:'avalanche-2',MATIC:'matic-network',POL:'matic-network',LINK:'chainlink',
  XRP:'ripple',LTC:'litecoin',BNB:'binancecoin',DOGE:'dogecoin',SHIB:'shiba-inu',
  UNI:'uniswap',ATOM:'cosmos',NEAR:'near',OP:'optimism',ARB:'arbitrum',
  WIF:'dogwifcoin',PEPE:'pepe',TON:'the-open-network',SUI:'sui',APT:'aptos',
  INJ:'injective-protocol',TIA:'celestia',SEI:'sei-network',THETA:'theta-token',
  TFUEL:'theta-fuel',SAND:'the-sandbox',MANA:'decentraland',AXS:'axie-infinity',
  FIL:'filecoin',ICP:'internet-computer',VET:'vechain',HBAR:'hedera-hashgraph',
  ALGO:'algorand',XLM:'stellar',ETC:'ethereum-classic',BCH:'bitcoin-cash',
  AAVE:'aave',MKR:'maker',LDO:'lido-dao',RUNE:'thorchain',FTM:'fantom',
  GRT:'the-graph',FLOW:'flow',KAVA:'kava',ZEC:'zcash',DASH:'dash',
  XMR:'monero',XTZ:'tezos',LUNA:'terra-luna-2',
  SNX:'synthetix-network-token',CRV:'curve-dao-token',SUSHI:'sushi',
  YFI:'yearn-finance',COMP:'compound-governance-token',BAT:'basic-attention-token',
  ONE:'harmony',ENJ:'enjincoin',CHZ:'chiliz',OCEAN:'ocean-protocol',ANKR:'ankr',
  DYDX:'dydx-chain',STX:'blockstack',RENDER:'render-token',FET:'fetch-ai',
  WLD:'worldcoin-wld',PYTH:'pyth-network',JTO:'jito-governance-token',
};
const CRYPTO_SET = new Set(Object.keys(CGIDS));

async function analyzeSpot(sym) {
  const isCrypto = CRYPTO_SET.has(sym);
  let bars;
  if (isCrypto) {
    bars = await fetchCGHistory(CGIDS[sym] || sym.toLowerCase());
  } else {
    // Acciones/ETFs/CEDEARs
    const yahooSym = sym.endsWith('.BA') ? sym : sym;
    bars = await fetchYahooHistory(yahooSym);
  }

  if (!bars || bars.length < 60) {
    return { error: `Datos insuficientes para "${sym}". Si es cripto verificá el ticker. Si es acción usá el símbolo de NYSE/NASDAQ.`, ticker: sym };
  }

  const closes  = bars.map(b => b.close);
  const highs   = bars.map(b => b.high || b.close);
  const lows    = bars.map(b => b.low  || b.close);
  const volumes = bars.map(b => b.volume || 0);
  const n = closes.length;
  const cur = closes[n - 1];

  // Indicadores base
  const ema20arr  = ema(closes, 20);
  const ema50arr  = ema(closes, 50);
  const ema200arr = ema(closes, Math.min(200, n - 1));
  const rsi14arr  = rsi(closes, 14);
  const vol20arr  = sma(volumes, 20);
  const atr14arr  = atr(highs, lows, closes, 14);

  const e20 = ema20arr[n-1], e50 = ema50arr[n-1], e200 = ema200arr[n-1];
  const rsiCur = rsi14arr[n-1], rsiPrev = rsi14arr[n-2];
  const volCur = volumes[n-1], volAvg = vol20arr[n-1];
  const volRatio = volAvg > 0 ? volCur / volAvg : 1;
  const atrCur = atr14arr[n-1] || (cur * 0.02);

  // 52-week range
  const windowBars = Math.min(252, n);
  const high52w = Math.max(...highs.slice(n - windowBars));
  const low52w  = Math.min(...lows.slice(n - windowBars));
  const distFromHigh = ((cur - high52w) / high52w) * 100;
  const distFromLow  = ((cur - low52w)  / low52w)  * 100;

  // Fibonacci sobre el swing del último año
  const fib = fibonacci(high52w, low52w);

  // Stage Weinstein
  let stage = 1, stageName = 'Base (Stage 1)';
  if (e50) {
    const e50Prev = ema50arr[n - 8] || e50;
    const rising = e50 > e50Prev;
    if (cur > e50 && rising)  { stage = 2; stageName = 'Avance (Stage 2)'; }
    if (cur > e50 && !rising) { stage = 3; stageName = 'Distribución (Stage 3)'; }
    if (cur < e50 && !rising) { stage = 4; stageName = 'Declive (Stage 4)'; }
  }

  // Regresión lineal para proyección
  const reg30  = linearRegression(closes.slice(-30), [7, 14, 30]);   // Mediano plazo (30d base)
  const reg90  = linearRegression(closes.slice(-90), [30, 60, 90]);  // Largo plazo (90d base)
  const reg7   = linearRegression(closes.slice(-7),  [3, 5, 7]);     // Corto plazo (7d base)

  // Soporte/resistencia por clusters de precios
  const supports    = findSupports(lows, n);
  const resistances = findResistances(highs, n);

  // Señales
  const signals = [];
  let score = 0;

  if (e20 && e50 && e200) {
    if (cur > e20 && e20 > e50 && e50 > e200) {
      signals.push({ icon: '📈', text: `Tendencia alcista perfecta: precio > EMA20 > EMA50 > EMA200`, bull: true }); score += 3;
    } else if (cur < e20 && e20 < e50 && e50 < e200) {
      signals.push({ icon: '📉', text: `Tendencia bajista perfecta: precio < EMA20 < EMA50 < EMA200`, bull: false }); score -= 3;
    } else if (cur > e50 && e50 > e200) {
      signals.push({ icon: '🔼', text: `Tendencia alcista intermedia: precio sobre EMA50 y EMA200`, bull: true }); score += 2;
    } else if (cur < e50) {
      signals.push({ icon: '🔽', text: `Precio bajo EMA50 — sesgo bajista`, bull: false }); score -= 1;
    }
  }

  if (rsiCur != null) {
    if (rsiCur < 30) { signals.push({ icon: '⚡', text: `RSI ${rsiCur.toFixed(1)} — sobreventa extrema, posible reversión alcista`, bull: true }); score += 2; }
    else if (rsiCur > 70) { signals.push({ icon: '⚠️', text: `RSI ${rsiCur.toFixed(1)} — sobrecompra, riesgo de corrección`, bull: false }); score -= 2; }
    else if (rsiCur > 55 && rsiCur > rsiPrev) { signals.push({ icon: '✅', text: `RSI ${rsiCur.toFixed(1)} — momentum alcista creciente`, bull: true }); score += 1; }
    else if (rsiCur < 45 && rsiCur < rsiPrev) { signals.push({ icon: '🔴', text: `RSI ${rsiCur.toFixed(1)} — momentum bajista`, bull: false }); score -= 1; }
    else { signals.push({ icon: '➡️', text: `RSI ${rsiCur.toFixed(1)} — zona neutral`, bull: null }); }
  }

  if (volRatio > 2 && cur > closes[n-2]) { signals.push({ icon: '🔊', text: `Volumen ${volRatio.toFixed(1)}x el promedio con cierre al alza — señal de acumulación fuerte`, bull: true }); score += 2; }
  else if (volRatio > 2) { signals.push({ icon: '🔊', text: `Volumen ${volRatio.toFixed(1)}x el promedio con cierre a la baja — señal de distribución fuerte`, bull: false }); score -= 2; }
  else if (volRatio > 1.4 && cur > closes[n-2]) { signals.push({ icon: '📢', text: `Volumen ${volRatio.toFixed(1)}x — fuerza compradora`, bull: true }); score += 1; }

  if (stage === 2) { signals.push({ icon: '🟢', text: `Stage 2 (Weinstein): tendencia alcista confirmada — zona ideal de compra`, bull: true }); score += 2; }
  else if (stage === 4) { signals.push({ icon: '🔴', text: `Stage 4 (Weinstein): tendencia bajista — evitar o vender`, bull: false }); score -= 2; }
  else if (stage === 1) { signals.push({ icon: '⏳', text: `Stage 1 (Weinstein): acumulación — esperar ruptura al alza con volumen`, bull: null }); }
  else if (stage === 3) { signals.push({ icon: '⚠️', text: `Stage 3 (Weinstein): distribución — reducir posición`, bull: false }); score -= 1; }

  // Fibonacci niveles cercanos
  const fibLevels = [
    { key: 'r_236', label: '23.6%', val: fib.r_236 },
    { key: 'r_382', label: '38.2%', val: fib.r_382 },
    { key: 'r_500', label: '50.0%', val: fib.r_500 },
    { key: 'r_618', label: '61.8%', val: fib.r_618 },
    { key: 'r_786', label: '78.6%', val: fib.r_786 },
  ];
  const nearFib = fibLevels.filter(f => Math.abs(f.val - cur) / cur < 0.02);
  if (nearFib.length > 0) {
    signals.push({ icon: '🌀', text: `Precio cerca del nivel Fibonacci ${nearFib[0].label} ($${nearFib[0].val.toFixed(4)}) — nivel técnico clave`, bull: null });
  }

  if (distFromHigh > -5) { signals.push({ icon: '🏔️', text: `Cerca del máximo 52 semanas ($${high52w.toFixed(4)}) — resistencia histórica`, bull: null }); }
  else if (distFromLow < 8) { signals.push({ icon: '🪃', text: `Cerca del mínimo 52 semanas ($${low52w.toFixed(4)}) — soporte histórico clave`, bull: true }); score += 1; }

  let verdict, verdictColor, verdictIcon;
  if (score >= 5)       { verdict = 'Compra fuerte';  verdictColor = '#22c55e'; verdictIcon = '🟢'; }
  else if (score >= 2)  { verdict = 'Compra';          verdictColor = '#86efac'; verdictIcon = '🔼'; }
  else if (score >= -1) { verdict = 'Neutral';          verdictColor = '#eab308'; verdictIcon = '⚖️'; }
  else if (score >= -4) { verdict = 'Venta';            verdictColor = '#fca5a5'; verdictIcon = '🔽'; }
  else                  { verdict = 'Venta fuerte';    verdictColor = '#ef4444'; verdictIcon = '🔴'; }

  return {
    ticker: sym, mode: 'spot',
    currentPrice: cur, verdict, verdictColor, verdictIcon, score,
    stage: stageName,
    ema20: e20, ema50: e50, ema200: e200,
    rsi: rsiCur, volRatio, atr: atrCur,
    high52w, low52w, distFromHigh, distFromLow,
    fibonacci: fib,
    nearFibLevels: nearFib,
    supports: supports.slice(0, 3),
    resistances: resistances.slice(0, 3),
    regression: {
      shortTerm:  reg7.projections,
      mediumTerm: reg30.projections,
      longTerm:   reg90.projections,
      slope30d: reg30.slope,
    },
    signals,
    analyzedAt: new Date().toISOString(),
    barsCount: n,
  };
}

function findSupports(lows, n, lookback = 60) {
  const result = [];
  const slice = lows.slice(Math.max(0, n - lookback), n);
  const sorted = [...new Set(slice.map(v => Math.round(v * 1000) / 1000))].sort((a, b) => a - b);
  // Agrupa precios cercanos
  let group = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if ((sorted[i] - group[group.length-1]) / group[group.length-1] < 0.008) {
      group.push(sorted[i]);
    } else {
      result.push(group.reduce((a, b) => a + b, 0) / group.length);
      group = [sorted[i]];
    }
  }
  if (group.length) result.push(group.reduce((a, b) => a + b, 0) / group.length);
  return result.sort((a, b) => b - a); // más cercano al precio actual primero
}

function findResistances(highs, n, lookback = 60) {
  const slice = highs.slice(Math.max(0, n - lookback), n);
  const sorted = [...new Set(slice.map(v => Math.round(v * 1000) / 1000))].sort((a, b) => b - a);
  const result = [];
  let group = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if ((group[group.length-1] - sorted[i]) / group[group.length-1] < 0.008) {
      group.push(sorted[i]);
    } else {
      result.push(group.reduce((a, b) => a + b, 0) / group.length);
      group = [sorted[i]];
    }
  }
  if (group.length) result.push(group.reduce((a, b) => a + b, 0) / group.length);
  return result;
}