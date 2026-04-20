/**
 * api/signals.js — v5 PROFESSIONAL
 * 
 * Análisis técnico multi-estrategia para CRIPTO y ACCIONES:
 * - Weinstein Stage Analysis (tendencia primaria)
 * - MACD (momentum) — Gerald Appel
 * - Bollinger Bands (volatilidad) — John Bollinger
 * - EMA 20/50/200 + Golden/Death Cross
 * - RSI 14 con divergencias — Welles Wilder
 * - OBV (On Balance Volume) — Joe Granville
 * - ATR para position sizing y targets
 * - Soporte/Resistencia por pivot points reales
 * - Fibonacci Retracements
 */

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { ticker, type, mode } = req.body || {};
  if (!ticker) return res.status(400).json({ error: 'Ticker requerido' });

  try {
    if (mode === 'futures') return res.status(200).json(await analyzeFutures(ticker.toUpperCase()));
    const result = await analyzeFull(ticker.toUpperCase(), type || 'auto');
    return res.status(200).json(result);
  } catch (err) {
    console.error('Signals error:', err);
    return res.status(500).json({ error: String(err), ticker });
  }
};

// ─────────────────────────────────────────────────────────
// DATA SOURCES
// ─────────────────────────────────────────────────────────

const CGIDS = {
  BTC:'bitcoin',ETH:'ethereum',SOL:'solana',ADA:'cardano',DOT:'polkadot',
  AVAX:'avalanche-2',MATIC:'matic-network',POL:'matic-network',LINK:'chainlink',
  XRP:'ripple',LTC:'litecoin',BNB:'binancecoin',DOGE:'dogecoin',SHIB:'shiba-inu',
  UNI:'uniswap',ATOM:'cosmos',NEAR:'near',OP:'optimism',ARB:'arbitrum',
  WIF:'dogwifcoin',PEPE:'pepe',TON:'the-open-network',SUI:'sui',APT:'aptos',
  INJ:'injective-protocol',TIA:'celestia',THETA:'theta-token',
  SAND:'the-sandbox',AXS:'axie-infinity',FIL:'filecoin',ICP:'internet-computer',
  HBAR:'hedera-hashgraph',ALGO:'algorand',XLM:'stellar',BCH:'bitcoin-cash',
  AAVE:'aave',MKR:'maker',LDO:'lido-dao',RUNE:'thorchain',
  FTM:'fantom',GRT:'the-graph',XMR:'monero',RENDER:'render-token',FET:'fetch-ai',
  STX:'blockstack',DYDX:'dydx-chain',ETC:'ethereum-classic',VET:'vechain',
};
const CRYPTO_SET = new Set(Object.keys(CGIDS));

function detectType(ticker, typeHint) {
  if (typeHint === 'crypto' || CRYPTO_SET.has(ticker)) return 'crypto';
  if (typeHint === 'cedear' || ticker.endsWith('.BA')) return 'cedear';
  return 'stock';
}

async function fetchHistory(ticker, assetType) {
  if (assetType === 'crypto') {
    const id = CGIDS[ticker] || ticker.toLowerCase();
    try {
      const r = await fetch(
        `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=365&interval=daily`
      );
      if (!r.ok) throw new Error('CoinGecko error ' + r.status);
      const d = await r.json();
      const prices = d.prices || [], vols = d.total_volumes || [];
      if (prices.length < 60) throw new Error('Insufficient data');
      return prices.map((p, i) => ({
        date: new Date(p[0]).toISOString().split('T')[0],
        close: p[1],
        high:  p[1] * 1.005,
        low:   p[1] * 0.995,
        volume: vols[i]?.[1] || 0,
        open:  p[1],
      }));
    } catch(e) { throw new Error(`No se pudo obtener datos de ${ticker}: ${e.message}`); }
  }

  // Stocks / CEDEARs via Yahoo Finance
  const sym = assetType === 'cedear' ? ticker + '.BA' : ticker;
  for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const r = await fetch(`${base}/v8/finance/chart/${sym}?interval=1d&range=1y`);
      if (!r.ok) continue;
      const d = await r.json();
      const res = d?.chart?.result?.[0];
      if (!res) continue;
      const ts = res.timestamp || [], q = res.indicators?.quote?.[0] || {};
      const bars = ts.map((t, i) => ({
        date:   new Date(t * 1000).toISOString().split('T')[0],
        open:   q.open?.[i]   || q.close?.[i],
        high:   q.high?.[i]   || q.close?.[i],
        low:    q.low?.[i]    || q.close?.[i],
        close:  q.close?.[i],
        volume: q.volume?.[i] || 0,
      })).filter(b => b.close != null && b.close > 0);
      if (bars.length >= 60) return bars;
    } catch { continue; }
  }
  throw new Error(`No se encontraron datos para "${ticker}". Verificá el ticker (ej: AAPL, MSFT, TSLA, SPY, BTC, ETH).`);
}

// ─────────────────────────────────────────────────────────
// INDICADORES TÉCNICOS
// ─────────────────────────────────────────────────────────

function calcEMA(data, period) {
  const k = 2 / (period + 1);
  const result = [];
  let prev = null;
  for (let i = 0; i < data.length; i++) {
    if (data[i] == null) { result.push(null); continue; }
    if (prev === null) {
      if (i < period - 1) { result.push(null); continue; }
      const slice = data.slice(0, period).filter(v => v != null);
      if (slice.length < period) { result.push(null); continue; }
      prev = slice.reduce((a, b) => a + b, 0) / period;
      result.push(prev); continue;
    }
    prev = data[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

function calcSMA(data, period) {
  return data.map((_, i) => {
    if (i < period - 1) return null;
    const sl = data.slice(i - period + 1, i + 1).filter(v => v != null);
    return sl.length === period ? sl.reduce((a, b) => a + b, 0) / period : null;
  });
}

function calcRSI(closes, period = 14) {
  const result = new Array(period).fill(null);
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) ag += d; else al += Math.abs(d);
  }
  ag /= period; al /= period;
  for (let i = period; i < closes.length; i++) {
    if (i > period) {
      const d = closes[i] - closes[i-1];
      ag = (ag * (period - 1) + Math.max(d, 0)) / period;
      al = (al * (period - 1) + Math.max(-d, 0)) / period;
    }
    result.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return result;
}

function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine = ema12.map((v, i) => (v != null && ema26[i] != null) ? v - ema26[i] : null);
  const signal = calcEMA(macdLine.filter(v => v != null), 9);
  // Realign signal with macdLine
  const firstValid = macdLine.findIndex(v => v != null);
  const signalFull = new Array(firstValid).fill(null);
  let si = 0;
  for (let i = firstValid; i < macdLine.length; i++) {
    signalFull.push(si < signal.length ? signal[si++] : null);
  }
  const histogram = macdLine.map((v, i) => (v != null && signalFull[i] != null) ? v - signalFull[i] : null);
  return { macdLine, signalLine: signalFull, histogram };
}

function calcBollinger(closes, period = 20, mult = 2) {
  const sma20 = calcSMA(closes, period);
  const bands = closes.map((_, i) => {
    if (i < period - 1) return { upper: null, mid: null, lower: null, width: null, pct: null };
    const sl = closes.slice(i - period + 1, i + 1);
    const mean = sl.reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(sl.map(v => (v - mean) ** 2).reduce((a, b) => a + b, 0) / period);
    const upper = mean + mult * std;
    const lower = mean - mult * std;
    const width = (upper - lower) / mean;
    const pct = lower !== upper ? (closes[i] - lower) / (upper - lower) : 0.5;
    return { upper, mid: mean, lower, width, pct };
  });
  return bands;
}

function calcATR(bars, period = 14) {
  const trs = bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    return Math.max(b.high - b.low, Math.abs(b.high - bars[i-1].close), Math.abs(b.low - bars[i-1].close));
  });
  return calcSMA(trs, period);
}

function calcOBV(bars) {
  const obv = [0];
  for (let i = 1; i < bars.length; i++) {
    const prev = obv[obv.length - 1];
    if (bars[i].close > bars[i-1].close) obv.push(prev + bars[i].volume);
    else if (bars[i].close < bars[i-1].close) obv.push(prev - bars[i].volume);
    else obv.push(prev);
  }
  return obv;
}

function calcStochastic(highs, lows, closes, kPeriod = 14, dPeriod = 3) {
  const k = closes.map((_, i) => {
    if (i < kPeriod - 1) return null;
    const sl_h = highs.slice(i - kPeriod + 1, i + 1);
    const sl_l = lows.slice(i - kPeriod + 1, i + 1);
    const highestH = Math.max(...sl_h);
    const lowestL  = Math.min(...sl_l);
    return highestH === lowestL ? 50 : ((closes[i] - lowestL) / (highestH - lowestL)) * 100;
  });
  const d = calcSMA(k.filter(v => v != null), dPeriod);
  const dFull = new Array(k.findIndex(v => v != null)).fill(null);
  let di = 0;
  for (let i = dFull.length; i < k.length; i++) dFull.push(di < d.length ? d[di++] : null);
  return { k, d: dFull };
}

// Detección de divergencias RSI
function detectDivergence(prices, rsi, lookback = 15) {
  const n = prices.length;
  if (n < lookback + 2) return { bullDiv: false, bearDiv: false };
  const priceSlice = prices.slice(n - lookback);
  const rsiSlice   = rsi.slice(n - lookback).filter(v => v != null);
  if (rsiSlice.length < 5) return { bullDiv: false, bearDiv: false };

  const priceMin1 = Math.min(...priceSlice.slice(-lookback/2));
  const priceMin2 = Math.min(...priceSlice.slice(0, lookback/2));
  const rsiMin1   = Math.min(...rsiSlice.slice(-Math.floor(rsiSlice.length/2)));
  const rsiMin2   = Math.min(...rsiSlice.slice(0, Math.floor(rsiSlice.length/2)));

  const priceMax1 = Math.max(...priceSlice.slice(-lookback/2));
  const priceMax2 = Math.max(...priceSlice.slice(0, lookback/2));
  const rsiMax1   = Math.max(...rsiSlice.slice(-Math.floor(rsiSlice.length/2)));
  const rsiMax2   = Math.max(...rsiSlice.slice(0, Math.floor(rsiSlice.length/2)));

  // Divergencia alcista: precio hace mínimo más bajo pero RSI hace mínimo más alto
  const bullDiv = priceMin1 < priceMin2 * 0.99 && rsiMin1 > rsiMin2 * 1.02;
  // Divergencia bajista: precio hace máximo más alto pero RSI hace máximo más bajo
  const bearDiv = priceMax1 > priceMax2 * 1.01 && rsiMax1 < rsiMax2 * 0.98;

  return { bullDiv, bearDiv };
}

function calcFibonacci(high, low) {
  const d = high - low;
  return {
    ext_2618: +(high + d * 1.618).toFixed(4),
    ext_1618: +(high + d * 0.618).toFixed(4),
    r_0:      +high.toFixed(4),
    r_236:    +(high - d * 0.236).toFixed(4),
    r_382:    +(high - d * 0.382).toFixed(4),
    r_500:    +(high - d * 0.5).toFixed(4),
    r_618:    +(high - d * 0.618).toFixed(4),
    r_786:    +(high - d * 0.786).toFixed(4),
    r_1000:   +low.toFixed(4),
  };
}

function findPivots(highs, lows, n, lookback = 90, wing = 3) {
  const sl_h = highs.slice(Math.max(0, n - lookback), n);
  const sl_l = lows.slice(Math.max(0, n - lookback), n);
  const pivH = [], pivL = [];
  for (let i = wing; i < sl_h.length - wing; i++) {
    if (sl_h.slice(i-wing,i).every(v=>v<=sl_h[i]) && sl_h.slice(i+1,i+wing+1).every(v=>v<=sl_h[i]))
      pivH.push(sl_h[i]);
    if (sl_l.slice(i-wing,i).every(v=>v>=sl_l[i]) && sl_l.slice(i+1,i+wing+1).every(v=>v>=sl_l[i]))
      pivL.push(sl_l[i]);
  }
  const cluster = (pts) => {
    if (!pts.length) return [];
    const sorted = [...pts].sort((a,b)=>a-b);
    const groups = []; let g = [sorted[0]];
    for (let i=1; i<sorted.length; i++) {
      if ((sorted[i]-g[g.length-1])/g[g.length-1] < 0.015) g.push(sorted[i]);
      else { groups.push(g); g = [sorted[i]]; }
    }
    groups.push(g);
    return groups.map(gr=>({ price:+(gr.reduce((a,b)=>a+b,0)/gr.length).toFixed(4), touches:gr.length }))
                 .sort((a,b)=>b.touches-a.touches);
  };
  return { pivotHighs: cluster(pivH), pivotLows: cluster(pivL) };
}

// ─────────────────────────────────────────────────────────
// ANÁLISIS PRINCIPAL
// ─────────────────────────────────────────────────────────

async function analyzeFull(ticker, typeHint) {
  const assetType = detectType(ticker, typeHint);
  const bars = await fetchHistory(ticker, assetType);
  const n = bars.length;

  const closes  = bars.map(b => b.close);
  const highs   = bars.map(b => b.high);
  const lows    = bars.map(b => b.low);
  const volumes = bars.map(b => b.volume);
  const cur = closes[n-1];
  const prev = closes[n-2];

  // ── INDICADORES ──
  const ema20arr  = calcEMA(closes, 20);
  const ema50arr  = calcEMA(closes, 50);
  const ema200arr = calcEMA(closes, Math.min(200, n-1));
  const sma30arr  = calcSMA(closes, 30);
  const macd      = calcMACD(closes);
  const bb        = calcBollinger(closes, 20, 2);
  const atrArr    = calcATR(bars, 14);
  const obvArr    = calcOBV(bars);
  const rsi14arr  = calcRSI(closes, 14);
  const stoch     = calcStochastic(highs, lows, closes, 14, 3);
  const vol20arr  = calcSMA(volumes, 20);

  const e20  = ema20arr[n-1];
  const e50  = ema50arr[n-1];
  const e200 = ema200arr[n-1];
  const ma30 = sma30arr[n-1];
  const ma30Prev = sma30arr[n-8] || ma30;
  const atrCur = atrArr[n-1] || cur * 0.02;
  const rsiCur  = rsi14arr[n-1];
  const rsiPrev = rsi14arr[n-2];
  const stochK  = stoch.k[n-1];
  const stochD  = stoch.d[n-1];
  const macdCur  = macd.macdLine[n-1];
  const macdPrev = macd.macdLine[n-2];
  const sigCur   = macd.signalLine[n-1];
  const sigPrev  = macd.signalLine[n-2];
  const histCur  = macd.histogram[n-1];
  const histPrev = macd.histogram[n-2];
  const bbCur    = bb[n-1];
  const obv      = obvArr[n-1];
  const obvPrev20= obvArr[n-21] || obv;
  const volCur   = volumes[n-1];
  const volAvg   = vol20arr[n-1];
  const volRatio = volAvg > 0 ? volCur / volAvg : 1;

  // Golden/Death Cross
  const e50Prev5  = ema50arr[n-6]  || e50;
  const e200Prev5 = ema200arr[n-6] || e200;
  const goldenCross = e50 > e200 && e50Prev5 <= e200Prev5;
  const deathCross  = e50 < e200 && e50Prev5 >= e200Prev5;
  const e50aboveE200 = e50 > e200;

  // 52-week range
  const w = Math.min(252, n);
  const high52w = Math.max(...highs.slice(n - w));
  const low52w  = Math.min(...lows.slice(n - w));
  const distFromHigh = +((cur - high52w) / high52w * 100).toFixed(1);
  const distFromLow  = +((cur - low52w)  / low52w  * 100).toFixed(1);

  // Fibonacci
  const fib = calcFibonacci(high52w, low52w);

  // Pivot points S/R
  const { pivotHighs, pivotLows } = findPivots(highs, lows, n, 90, 3);
  const resistances = pivotHighs.filter(p => p.price > cur * 1.005).sort((a,b)=>a.price-b.price).slice(0,4);
  const supports    = pivotLows.filter(p =>  p.price < cur * 0.995).sort((a,b)=>b.price-a.price).slice(0,4);

  // RSI divergences
  const { bullDiv, bearDiv } = detectDivergence(closes, rsi14arr, 20);

  // Weinstein Stage
  const ma30Rising  = ma30 > ma30Prev * 1.002;
  const ma30Falling = ma30 < ma30Prev * 0.998;
  let stage = 1, stageName = 'Stage 1 — Acumulación';
  if      (cur > ma30 &&  ma30Rising)  { stage = 2; stageName = 'Stage 2 — Avance'; }
  else if (cur > ma30 && !ma30Rising && !ma30Falling) { stage = 3; stageName = 'Stage 3 — Distribución'; }
  else if (cur < ma30 && (ma30Falling || !ma30Rising)) { stage = 4; stageName = 'Stage 4 — Declive'; }

  // OBV trend
  const obvRising = obv > obvPrev20 * 1.02;
  const obvFalling = obv < obvPrev20 * 0.98;

  // ── SCORING MULTI-ESTRATEGIA ──
  const signals = [];
  let bullScore = 0, bearScore = 0;

  // [1] WEINSTEIN STAGE (peso 4 — señal primaria de tendencia)
  if (stage === 2) {
    signals.push({ category:'Weinstein', icon:'📊', text:`Stage 2 — Avance: MA30 subiendo con precio arriba. Zona de compra según Weinstein (Secrets for Profiting in Bull & Bear Markets, 1988)`, bull:true, weight:4 });
    bullScore += 4;
  } else if (stage === 4) {
    signals.push({ category:'Weinstein', icon:'📊', text:`Stage 4 — Declive: MA30 bajando con precio abajo. Weinstein: evitar o vender posiciones largas`, bull:false, weight:4 });
    bearScore += 4;
  } else if (stage === 3) {
    signals.push({ category:'Weinstein', icon:'📊', text:`Stage 3 — Distribución: MA30 aplanando con precio arriba. Weinstein: reducir exposición gradualmente`, bull:false, weight:2 });
    bearScore += 2;
  } else {
    signals.push({ category:'Weinstein', icon:'📊', text:`Stage 1 — Acumulación/Base: precio lateral cerca de MA30. Weinstein: esperar ruptura con volumen para confirmar Stage 2`, bull:null, weight:0 });
  }

  // [2] GOLDEN/DEATH CROSS (peso 3)
  if (goldenCross) {
    signals.push({ category:'Cruce EMAs', icon:'✨', text:`Golden Cross: EMA50 cruzó hacia arriba la EMA200 — señal alcista de largo plazo muy relevante. Históricamente precede tendencias alcistas sostenidas`, bull:true, weight:3 });
    bullScore += 3;
  } else if (deathCross) {
    signals.push({ category:'Cruce EMAs', icon:'💀', text:`Death Cross: EMA50 cruzó hacia abajo la EMA200 — señal bajista de largo plazo. Precede correcciones significativas`, bull:false, weight:3 });
    bearScore += 3;
  } else if (e50aboveE200) {
    signals.push({ category:'Cruce EMAs', icon:'📈', text:`EMA50 ($${e50.toFixed(2)}) sobre EMA200 ($${e200.toFixed(2)}) — estructura alcista de largo plazo activa`, bull:true, weight:1 });
    bullScore += 1;
  } else {
    signals.push({ category:'Cruce EMAs', icon:'📉', text:`EMA50 ($${e50.toFixed(2)}) bajo EMA200 ($${e200.toFixed(2)}) — estructura bajista de largo plazo`, bull:false, weight:1 });
    bearScore += 1;
  }

  // [3] ALINEACIÓN EMA (peso 2)
  if (e20 && e50 && e200) {
    if (cur > e20 && e20 > e50 && e50 > e200) {
      signals.push({ category:'EMAs', icon:'🔼', text:`Alineación perfecta alcista: precio > EMA20 > EMA50 > EMA200. Tendencia de corto, mediano y largo plazo en la misma dirección`, bull:true, weight:2 });
      bullScore += 2;
    } else if (cur < e20 && e20 < e50 && e50 < e200) {
      signals.push({ category:'EMAs', icon:'🔽', text:`Alineación perfecta bajista: precio < EMA20 < EMA50 < EMA200. Presión vendedora en los tres timeframes simultáneamente`, bull:false, weight:2 });
      bearScore += 2;
    } else if (cur > e50) {
      signals.push({ category:'EMAs', icon:'↗️', text:`Precio ($${cur.toFixed(2)}) sobre EMA50 ($${e50.toFixed(2)}) — zona de control alcista. EMA50 actúa como soporte dinámico`, bull:true, weight:1 });
      bullScore += 1;
    } else {
      signals.push({ category:'EMAs', icon:'↘️', text:`Precio ($${cur.toFixed(2)}) bajo EMA50 ($${e50.toFixed(2)}) — EMA50 actúa como resistencia dinámica. Sesgo bajista`, bull:false, weight:1 });
      bearScore += 1;
    }
  }

  // [4] MACD (peso 3) — Gerald Appel
  if (macdCur != null && sigCur != null) {
    const crossUp   = macdCur > sigCur && macdPrev <= (sigPrev||sigCur);
    const crossDown = macdCur < sigCur && macdPrev >= (sigPrev||sigCur);
    const histAccel = histCur != null && histPrev != null && Math.abs(histCur) > Math.abs(histPrev);

    if (crossUp && macdCur < 0) {
      signals.push({ category:'MACD', icon:'⚡', text:`MACD cruzó señal hacia arriba en zona negativa — señal alcista de alta calidad (Appel). Divergencia positiva desde sobrevendido`, bull:true, weight:3 });
      bullScore += 3;
    } else if (crossUp) {
      signals.push({ category:'MACD', icon:'⚡', text:`MACD cruzó señal hacia arriba — señal alcista (Appel). Momentum cambiando a positivo`, bull:true, weight:2 });
      bullScore += 2;
    } else if (crossDown && macdCur > 0) {
      signals.push({ category:'MACD', icon:'⚡', text:`MACD cruzó señal hacia abajo en zona positiva — señal bajista de alta calidad (Appel). Agotamiento del alza`, bull:false, weight:3 });
      bearScore += 3;
    } else if (crossDown) {
      signals.push({ category:'MACD', icon:'⚡', text:`MACD cruzó señal hacia abajo — señal bajista (Appel). Momentum cambiando a negativo`, bull:false, weight:2 });
      bearScore += 2;
    } else if (macdCur > sigCur && histAccel) {
      signals.push({ category:'MACD', icon:'📈', text:`MACD sobre señal con histograma acelerando — momentum alcista en expansión`, bull:true, weight:1 });
      bullScore += 1;
    } else if (macdCur < sigCur && histAccel) {
      signals.push({ category:'MACD', icon:'📉', text:`MACD bajo señal con histograma acelerando — momentum bajista en expansión`, bull:false, weight:1 });
      bearScore += 1;
    } else {
      signals.push({ category:'MACD', icon:'➡️', text:`MACD ${macdCur > sigCur ? 'sobre' : 'bajo'} señal pero sin aceleración — momentum ${macdCur > sigCur ? 'positivo' : 'negativo'} pero estable`, bull:macdCur > sigCur, weight:0 });
    }
  }

  // [5] RSI con divergencias (peso 2-3) — Welles Wilder
  if (rsiCur != null) {
    if (bullDiv) {
      signals.push({ category:'RSI', icon:'🔄', text:`Divergencia alcista RSI (Wilder): precio hace mínimo más bajo pero RSI NO confirma. Señal de agotamiento vendedor y posible reversión. Alta confiabilidad`, bull:true, weight:3 });
      bullScore += 3;
    } else if (bearDiv) {
      signals.push({ category:'RSI', icon:'🔄', text:`Divergencia bajista RSI (Wilder): precio hace máximo más alto pero RSI NO confirma. Señal de agotamiento comprador y posible techo. Alta confiabilidad`, bull:false, weight:3 });
      bearScore += 3;
    } else if (rsiCur < 30) {
      signals.push({ category:'RSI', icon:'🟢', text:`RSI ${rsiCur.toFixed(1)} — Sobreventa extrema (Wilder). Zona de alta probabilidad de rebote. Combinar con otras señales para confirmar`, bull:true, weight:2 });
      bullScore += 2;
    } else if (rsiCur > 70) {
      signals.push({ category:'RSI', icon:'🔴', text:`RSI ${rsiCur.toFixed(1)} — Sobrecompra (Wilder). Zona de riesgo elevado. Posible corrección o consolidación próxima`, bull:false, weight:2 });
      bearScore += 2;
    } else if (rsiCur > 55 && rsiCur > rsiPrev) {
      signals.push({ category:'RSI', icon:'⬆️', text:`RSI ${rsiCur.toFixed(1)} subiendo en zona de fuerza (>50). Momentum alcista sostenido sin sobrecompra`, bull:true, weight:1 });
      bullScore += 1;
    } else if (rsiCur < 45 && rsiCur < rsiPrev) {
      signals.push({ category:'RSI', icon:'⬇️', text:`RSI ${rsiCur.toFixed(1)} bajando en zona de debilidad (<50). Momentum bajista persistente`, bull:false, weight:1 });
      bearScore += 1;
    } else {
      signals.push({ category:'RSI', icon:'➡️', text:`RSI ${rsiCur.toFixed(1)} — zona neutral. Sin señal clara de sobrecompra ni sobreventa`, bull:null, weight:0 });
    }
  }

  // [6] BOLLINGER BANDS (peso 2) — John Bollinger
  if (bbCur && bbCur.upper) {
    const bbPct = bbCur.pct;
    const bbWidth = bbCur.width;
    const prevBB = bb[n-2];
    const squeeze = bbWidth < 0.05; // bandas muy contraídas = volatilidad comprimida

    if (squeeze) {
      signals.push({ category:'Bollinger', icon:'🎯', text:`Bollinger Squeeze (Bollinger): bandas muy contraídas (ancho ${(bbWidth*100).toFixed(1)}%). Compresión de volatilidad — se acerca movimiento explosivo. Dirección definida por el próximo breakout`, bull:null, weight:1 });
    } else if (cur > bbCur.upper) {
      signals.push({ category:'Bollinger', icon:'🔴', text:`Precio sobre banda superior de Bollinger ($${bbCur.upper.toFixed(2)}). Extensión de corto plazo — posible reversión o consolidación. No es venta automática en tendencia alcista`, bull:false, weight:2 });
      bearScore += 2;
    } else if (cur < bbCur.lower) {
      signals.push({ category:'Bollinger', icon:'🟢', text:`Precio bajo banda inferior de Bollinger ($${bbCur.lower.toFixed(2)}). Sobreventa de corto plazo — posible rebote técnico. Confluencia con soporte aumenta probabilidad`, bull:true, weight:2 });
      bullScore += 2;
    } else if (bbPct > 0.8 && cur > bbCur.mid) {
      signals.push({ category:'Bollinger', icon:'⚠️', text:`Precio en percentil ${(bbPct*100).toFixed(0)}% de las Bandas de Bollinger — zona alta de la banda. Precaución`, bull:null, weight:0 });
    } else if (bbPct < 0.2 && cur < bbCur.mid) {
      signals.push({ category:'Bollinger', icon:'💡', text:`Precio en percentil ${(bbPct*100).toFixed(0)}% de las Bandas de Bollinger — zona baja. Potencial de rebote hacia la media ($${bbCur.mid.toFixed(2)})`, bull:true, weight:1 });
      bullScore += 1;
    } else {
      signals.push({ category:'Bollinger', icon:'📊', text:`Bollinger: precio en ${(bbPct*100).toFixed(0)}% de las bandas. Media: $${bbCur.mid.toFixed(2)} | Superior: $${bbCur.upper.toFixed(2)} | Inferior: $${bbCur.lower.toFixed(2)}`, bull:cur > bbCur.mid, weight:0 });
    }
  }

  // [7] OBV — Joe Granville (peso 2)
  if (obvArr.length > 21) {
    if (obvRising && cur > prev) {
      signals.push({ category:'OBV', icon:'💹', text:`OBV (Granville) subiendo con precio en alza — volumen confirma el movimiento alcista. Señal de acumulación institucional genuina`, bull:true, weight:2 });
      bullScore += 2;
    } else if (obvFalling && cur < prev) {
      signals.push({ category:'OBV', icon:'📤', text:`OBV (Granville) bajando con precio en baja — volumen confirma presión vendedora. Distribución activa`, bull:false, weight:2 });
      bearScore += 2;
    } else if (obvRising && cur < prev) {
      signals.push({ category:'OBV', icon:'🔍', text:`Divergencia alcista OBV (Granville): volumen neto acumulándose aunque precio baja. Acumulación silenciosa — señal positiva`, bull:true, weight:2 });
      bullScore += 2;
    } else if (obvFalling && cur > prev) {
      signals.push({ category:'OBV', icon:'⚠️', text:`Divergencia bajista OBV (Granville): volumen neto cayendo aunque precio sube. Distribución silenciosa — señal negativa`, bull:false, weight:2 });
      bearScore += 2;
    }
  }

  // [8] ESTOCÁSTICO (peso 1)
  if (stochK != null && stochD != null) {
    if (stochK < 20 && stochK > stochD) {
      signals.push({ category:'Estocástico', icon:'🟢', text:`Estocástico ${stochK.toFixed(1)} en zona de sobreventa (<20) con K sobre D — señal de compra en sobrevendido`, bull:true, weight:1 });
      bullScore += 1;
    } else if (stochK > 80 && stochK < stochD) {
      signals.push({ category:'Estocástico', icon:'🔴', text:`Estocástico ${stochK.toFixed(1)} en sobrecompra (>80) con K bajo D — señal de venta en sobrecomprado`, bull:false, weight:1 });
      bearScore += 1;
    }
  }

  // [9] VOLUMEN (peso 1)
  if (volRatio > 2 && cur > prev) {
    signals.push({ category:'Volumen', icon:'🔊', text:`Volumen ${volRatio.toFixed(1)}x el promedio en vela alcista — señal de acumulación fuerte. Breakout o impulso con convicción`, bull:true, weight:1 });
    bullScore += 1;
  } else if (volRatio > 2 && cur < prev) {
    signals.push({ category:'Volumen', icon:'🔊', text:`Volumen ${volRatio.toFixed(1)}x el promedio en vela bajista — señal de distribución fuerte. Presión vendedora con convicción`, bull:false, weight:1 });
    bearScore += 1;
  }

  // [10] FIBONACCI
  const fibLevels = [
    { l:'Ext 161.8%', v:fib.ext_1618 },
    { l:'Ret 23.6%',  v:fib.r_236 },
    { l:'Ret 38.2%',  v:fib.r_382 },
    { l:'Ret 50.0%',  v:fib.r_500 },
    { l:'Ret 61.8%',  v:fib.r_618 },
    { l:'Ret 78.6%',  v:fib.r_786 },
  ];
  const nearFib = fibLevels.filter(f => Math.abs(f.v - cur) / cur < 0.018);
  if (nearFib.length) {
    signals.push({ category:'Fibonacci', icon:'🌀', text:`Precio en nivel Fibonacci ${nearFib[0].l} ($${nearFib[0].v}) — zona técnica de alta confluencia. Frecuente punto de reversión o continuación`, bull:null, weight:0 });
  }

  // ── SCORE FINAL ──
  const totalScore = bullScore - bearScore;

  let verdict, verdictColor, verdictIcon;
  if      (totalScore >= 8)  { verdict='Compra muy fuerte'; verdictColor='#22c55e'; verdictIcon='🟢'; }
  else if (totalScore >= 5)  { verdict='Compra';             verdictColor='#86efac'; verdictIcon='🔼'; }
  else if (totalScore >= 2)  { verdict='Leve sesgo alcista'; verdictColor='#a7f3d0'; verdictIcon='↗️'; }
  else if (totalScore >= -1) { verdict='Neutral';             verdictColor='#eab308'; verdictIcon='⚖️'; }
  else if (totalScore >= -4) { verdict='Leve sesgo bajista'; verdictColor='#fca5a5'; verdictIcon='↘️'; }
  else if (totalScore >= -7) { verdict='Venta';               verdictColor='#f87171'; verdictIcon='🔽'; }
  else                       { verdict='Venta muy fuerte';   verdictColor='#ef4444'; verdictIcon='🔴'; }

  // ── ACCIÓN RECOMENDADA ──
  const action = buildAction(totalScore, stage, rsiCur, distFromHigh, distFromLow, e50aboveE200, obvRising, macdCur, sigCur, volRatio);

  // ── TARGETS DINÁMICOS ──
  const targets = buildTargets(cur, atrCur, resistances, supports, fib, e50, e200, bbCur);

  // ── ESCENARIOS ──
  const scenarios = buildScenarios(cur, totalScore, stage, targets, e50, e200, resistances, supports, macdCur, sigCur, rsiCur);

  // ── PROYECCIONES TÉCNICAS REALES ──
  const projections = buildProjections({
    bars, closes, highs, lows, cur, n,
    e20, e50, e200, ma30, atrCur, fib,
    high52w, low52w, totalScore, stage, bullScore, bearScore,
    resistances, supports, bbCur,
  });

  return {
    ticker, assetType, mode:'spot',
    currentPrice:       +cur.toFixed(4),
    prevClose:          +prev.toFixed(4),
    changePercent:      +((cur-prev)/prev*100).toFixed(2),
    verdict, verdictColor, verdictIcon,
    bullScore, bearScore, totalScore,
    stage: stageName,
    indicators: {
      ema20:   e20   ? +e20.toFixed(4)   : null,
      ema50:   e50   ? +e50.toFixed(4)   : null,
      ema200:  e200  ? +e200.toFixed(4)  : null,
      ma30:    ma30  ? +ma30.toFixed(4)  : null,
      rsi:     rsiCur ? +rsiCur.toFixed(1) : null,
      macdLine:  macdCur ? +macdCur.toFixed(4) : null,
      macdSignal: sigCur ? +sigCur.toFixed(4) : null,
      macdHist:  histCur ? +histCur.toFixed(4) : null,
      stochK:  stochK ? +stochK.toFixed(1) : null,
      stochD:  stochD ? +stochD.toFixed(1) : null,
      bbUpper: bbCur?.upper ? +bbCur.upper.toFixed(4) : null,
      bbMid:   bbCur?.mid   ? +bbCur.mid.toFixed(4)   : null,
      bbLower: bbCur?.lower ? +bbCur.lower.toFixed(4) : null,
      bbWidth: bbCur?.width ? +bbCur.width.toFixed(3)  : null,
      bbPct:   bbCur?.pct   ? +bbCur.pct.toFixed(2)    : null,
      atr:     +atrCur.toFixed(4),
      atrPct:  +((atrCur/cur)*100).toFixed(2),
      volRatio: +volRatio.toFixed(2),
      obvTrend: obvRising ? 'rising' : obvFalling ? 'falling' : 'flat',
    },
    crossovers: { goldenCross, deathCross, e50aboveE200 },
    divergences: { bullDiv, bearDiv },
    high52w: +high52w.toFixed(4),
    low52w:  +low52w.toFixed(4),
    distFromHigh, distFromLow,
    fibonacci: fib,
    nearFibLevels: nearFib,
    resistances: resistances.slice(0,4),
    supports:    supports.slice(0,4),
    signals,
    action, targets, scenarios, projections,
    analyzedAt:  new Date().toISOString(),
    barsCount:   n,
  };
}

function buildAction(score, stage, rsi, distHigh, distLow, e50above200, obvRising, macdLine, macdSig, volRatio) {
  let action, actionColor, actionIcon, reasons = [], warning = null;

  if (stage === 2 && score >= 5) {
    action='ACUMULAR'; actionColor='#22c55e'; actionIcon='🟢';
    reasons.push('Stage 2 de Weinstein activo: la tendencia primaria es alcista y el momentum acompaña');
    reasons.push('Múltiples indicadores en alineación alcista (score '+score+' sobre máximo posible)');
    if (e50above200) reasons.push('Golden Cross activo: EMA50 sobre EMA200 confirma tendencia de largo plazo');
    if (obvRising)   reasons.push('OBV subiendo: el volumen neto confirma acumulación institucional real');
    if (rsi && rsi < 60) reasons.push('RSI en '+rsi.toFixed(1)+': hay espacio para continuar sin sobrecompra');
  } else if (stage === 2 && score >= 2) {
    action='MANTENER/AGREGAR'; actionColor='#86efac'; actionIcon='🔼';
    reasons.push('Stage 2 activo pero con algunas señales mixtas');
    reasons.push('Mantener posición existente. Agregar en pullbacks hacia EMA20 o EMA50');
    if (rsi && rsi > 65) { reasons.push('RSI en '+rsi.toFixed(1)+': sobrecompra de corto plazo, esperar corrección para agregar'); }
    warning = distHigh > -5 ? 'Precio cerca del máximo anual, posible resistencia' : null;
  } else if (stage === 1) {
    action='ESPERAR'; actionColor='#eab308'; actionIcon='⏳';
    reasons.push('Stage 1 de Weinstein: zona de base/acumulación sin tendencia definida');
    reasons.push('Esperá ruptura de la resistencia con volumen >1.5x el promedio para confirmar Stage 2');
    reasons.push('Mientras tanto: observar, no operar. El tiempo en Stage 1 puede ser largo');
  } else if (stage === 3) {
    action='REDUCIR POSICIÓN'; actionColor='#fca5a5'; actionIcon='🔽';
    reasons.push('Stage 3 de Weinstein: señales de distribución. Los "smart money" están vendiendo');
    reasons.push('Reducir exposición gradualmente. No vender todo de golpe pero sí ir aligerando');
    reasons.push('Mantener stops ajustados bajo MA30 y EMA50');
    warning = 'Peligro de transición hacia Stage 4. Monitoreá de cerca';
  } else if (stage === 4 || score <= -5) {
    action='SALIR'; actionColor='#ef4444'; actionIcon='🔴';
    reasons.push(stage===4 ? 'Stage 4 de Weinstein: tendencia bajista confirmada — no hay rebote sostenible' : 'Score técnico muy negativo: múltiples estrategias alineadas a la baja');
    reasons.push('Salir de posiciones largas. Los rebotes en Stage 4 son trampas bajistas');
    reasons.push('Para volver a entrar: esperar confirmación de Stage 2 desde cero');
    warning = 'Alto riesgo. Priorizar preservación de capital';
  } else {
    action='NEUTRAL'; actionColor='#eab308'; actionIcon='⚖️';
    reasons.push('Señales técnicas mixtas sin dirección clara predominante');
    reasons.push('Esperar mayor definición antes de tomar posición nueva');
  }

  return { action, actionColor, actionIcon, reasons, warning };
}

function buildTargets(cur, atr, resistances, supports, fib, e50, e200, bb) {
  const targets = { upside: [], downside: [], stopLoss: null, riskReward: null };

  // Upside targets: resistencias + Fibonacci + ATR
  if (resistances[0]) targets.upside.push({ label:'R1 — Resistencia', price: resistances[0].price, type:'resistance', touches: resistances[0].touches });
  if (resistances[1]) targets.upside.push({ label:'R2 — Resistencia', price: resistances[1].price, type:'resistance', touches: resistances[1].touches });
  if (fib.r_236 > cur) targets.upside.push({ label:'Fib 23.6%', price: fib.r_236, type:'fibonacci' });
  if (fib.r_0 > cur)   targets.upside.push({ label:'Máximo 52s', price: fib.r_0, type:'high52w' });

  // Downside / Stop Loss
  if (supports[0]) targets.downside.push({ label:'S1 — Soporte', price: supports[0].price, type:'support', touches: supports[0].touches });
  if (supports[1]) targets.downside.push({ label:'S2 — Soporte', price: supports[1].price, type:'support', touches: supports[1].touches });
  if (fib.r_382 < cur) targets.downside.push({ label:'Fib 38.2%', price: fib.r_382, type:'fibonacci' });

  // Stop loss sugerido: 1.5x ATR bajo mínimo reciente
  const slPrice = +(cur - atr * 1.5).toFixed(4);
  targets.stopLoss = { price: slPrice, atrMultiple: 1.5, distPct: +((slPrice-cur)/cur*100).toFixed(2) };

  // R:R
  if (targets.upside[0] && slPrice) {
    const gain = targets.upside[0].price - cur;
    const risk = cur - slPrice;
    targets.riskReward = risk > 0 ? +(gain / risk).toFixed(2) : null;
  }

  return targets;
}

function buildScenarios(cur, score, stage, targets, e50, e200, resistances, supports, macdLine, macdSig, rsi) {
  const r1 = targets.upside[0];
  const s1 = targets.downside[0];

  const bullProb = score >= 6 ? 'Alta' : score >= 3 ? 'Media-Alta' : score >= 0 ? 'Media' : 'Baja';
  const bearProb = score <= -6 ? 'Alta' : score <= -3 ? 'Media-Alta' : score <= 0 ? 'Media' : 'Baja';

  return [
    {
      label: 'Escenario alcista',
      icon: '📈', color: '#22c55e',
      condition: 'El precio mantiene soportes clave y el volumen comprador se sostiene',
      triggers: [
        stage===2 ? 'Stage 2 activo: momentum de fondo favorable' : 'Ruptura de Stage 1/3 con volumen confirmatorio',
        r1 ? `Primera resistencia a romper: $${r1.price} (${r1.touches} contactos previos)` : 'Ver niveles de resistencia arriba',
        macdLine > macdSig ? 'MACD sobre señal: momentum positivo activo' : 'MACD necesita cruzar hacia arriba para confirmar',
      ],
      target: r1 ? `$${r1.price}` : 'Ver resistencias',
      targetPct: r1 ? `+${((r1.price-cur)/cur*100).toFixed(1)}%` : null,
      probability: bullProb,
    },
    {
      label: 'Escenario base (lateral)',
      icon: '↔️', color: '#eab308',
      condition: 'Consolidación entre soporte y resistencia más cercanos',
      triggers: [
        e50 ? `EMA50 ($${e50.toFixed(2)}) como soporte/resistencia dinámico central` : 'Ver EMAs',
        s1 && r1 ? `Rango: $${s1.price} — $${r1.price}` : 'Rango definido por S/R más cercanos',
        'Típico en Stage 1 o tras movimientos extensos sin catalizador nuevo',
      ],
      target: e50 ? `$${e50.toFixed(2)} (EMA50)` : 'Lateral',
      targetPct: e50 ? `${((e50-cur)/cur*100).toFixed(1)}%` : null,
      probability: 'Siempre posible',
    },
    {
      label: 'Escenario bajista',
      icon: '📉', color: '#ef4444',
      condition: 'Rompe soporte clave con volumen, confirmando presión vendedora',
      triggers: [
        s1 ? `Soporte crítico: $${s1.price} — si rompe con volumen, acelera la caída` : 'Ver soportes abajo',
        stage===4 ? 'Stage 4 activo: tendencia bajista de fondo' : stage===3 ? 'Riesgo de transición Stage 3→4' : 'Posible corrección técnica',
        e200 && cur < e200 ? `Precio bajo EMA200 ($${e200.toFixed(2)}): resistencia de largo plazo` : e200 ? `EMA200 ($${e200.toFixed(2)}) como soporte clave de largo plazo` : '',
        rsi && rsi > 60 ? 'RSI en zona alta: corrección posible sin señal de fondo' : '',
      ].filter(Boolean),
      target: s1 ? `$${s1.price}` : 'Ver soportes',
      targetPct: s1 ? `${((s1.price-cur)/cur*100).toFixed(1)}%` : null,
      probability: bearProb,
    },
  ];
}

// ─────────────────────────────────────────────────────────
// PROYECCIONES TÉCNICAS REALES
// ─────────────────────────────────────────────────────────
// Estrategias usadas:
// 1. Weinstein Stage + Canal de precio (Price Channel)
//    — Identifica el canal de tendencia real midiendo
//      la distancia histórica del precio a la MA30
// 2. Bollinger Bands histórico (ancho promedio)
//    — Proyecta rangos de expansión realistas basados
//      en la volatilidad histórica del activo específico
// 3. Niveles técnicos clave (S/R + Fibonacci)
//    — Targets naturales donde el precio tiende a frenar

function buildProjections({ bars, closes, highs, lows, cur, n,
  e20, e50, e200, ma30, atrCur, fib,
  high52w, low52w, totalScore, stage, bullScore, bearScore,
  resistances, supports, bbCur }) {

  // ── 1. CANAL DE PRECIO (Price Channel) ──────────────────
  // Basado en la metodología de Weinstein:
  // medimos la amplitud real del canal de tendencia
  // usando los últimos 90 días de datos históricos
  const lookback90  = closes.slice(Math.max(0, n - 90));
  const lookback180 = closes.slice(Math.max(0, n - 180));
  const lookback30  = closes.slice(Math.max(0, n - 30));

  const high90  = Math.max(...highs.slice(Math.max(0, n - 90)));
  const low90   = Math.min(...lows.slice(Math.max(0, n - 90)));
  const high180 = Math.max(...highs.slice(Math.max(0, n - 180)));
  const low180  = Math.min(...lows.slice(Math.max(0, n - 180)));

  // Amplitud del canal como % del precio actual
  const channelAmp90  = (high90  - low90)  / cur;  // amplitud 3 meses
  const channelAmp180 = (high180 - low180) / cur;  // amplitud 6 meses

  // Tendencia del canal: pendiente de MA30 en últimos 60 días
  const ma30_now   = ma30;
  const ma30_60ago = closes.slice(Math.max(0, n - 60), Math.max(0, n - 57))
    .reduce((a, b) => a + b, 0) / 3 || ma30;
  const ma30_slope = (ma30_now - ma30_60ago) / ma30_60ago; // % cambio en 60 días

  // Proyección del canal: MA30 + su tendencia × tiempo
  const channelCenter30d  = ma30 * (1 + ma30_slope * (30 / 60));
  const channelCenter90d  = ma30 * (1 + ma30_slope * (90 / 60));
  const channelCenter180d = ma30 * (1 + ma30_slope * (180 / 60));

  // Límites del canal usando amplitud histórica
  const chan30_up  = +(channelCenter30d  * (1 + channelAmp90  * 0.5)).toFixed(4);
  const chan30_dn  = +(channelCenter30d  * (1 - channelAmp90  * 0.5)).toFixed(4);
  const chan90_up  = +(channelCenter90d  * (1 + channelAmp90  * 0.6)).toFixed(4);
  const chan90_dn  = +(channelCenter90d  * (1 - channelAmp90  * 0.6)).toFixed(4);
  const chan180_up = +(channelCenter180d * (1 + channelAmp180 * 0.5)).toFixed(4);
  const chan180_dn = +(channelCenter180d * (1 - channelAmp180 * 0.5)).toFixed(4);

  // ── 2. BOLLINGER HISTÓRICO ───────────────────────────────
  // Calculamos el ancho promedio de Bollinger en los últimos
  // 90 días para entender la volatilidad real del activo
  // y proyectar rangos estadísticamente plausibles

  // Volatilidad histórica: desv estándar de retornos logarítmicos
  const returns = [];
  for (let i = Math.max(1, n - 90); i < n; i++) {
    if (closes[i] > 0 && closes[i-1] > 0)
      returns.push(Math.log(closes[i] / closes[i-1]));
  }
  const meanRet = returns.reduce((a, b) => a + b, 0) / (returns.length || 1);
  const variance = returns.map(r => (r - meanRet) ** 2).reduce((a, b) => a + b, 0) / (returns.length || 1);
  const dailyVolPct = Math.sqrt(variance) * 100; // % diario

  // Bandas de 1σ y 1.5σ para cada horizonte
  // (1σ = 68% de probabilidad, 1.5σ = 87% de prob)
  const vol30d_1s  = dailyVolPct * Math.sqrt(30)  / 100 * cur;
  const vol90d_1s  = dailyVolPct * Math.sqrt(90)  / 100 * cur;
  const vol180d_1s = dailyVolPct * Math.sqrt(180) / 100 * cur;

  const bb30_up  = +(cur + vol30d_1s  * 1.5).toFixed(4);
  const bb30_dn  = +(Math.max(cur - vol30d_1s  * 1.5, cur * 0.05)).toFixed(4);
  const bb90_up  = +(cur + vol90d_1s  * 1.5).toFixed(4);
  const bb90_dn  = +(Math.max(cur - vol90d_1s  * 1.5, cur * 0.05)).toFixed(4);
  const bb180_up = +(cur + vol180d_1s * 1.5).toFixed(4);
  const bb180_dn = +(Math.max(cur - vol180d_1s * 1.5, cur * 0.05)).toFixed(4);

  // ── 3. NIVELES TÉCNICOS (S/R + Fibonacci) ───────────────
  // Targets naturales donde el precio históricamente frena
  // Usamos los pivot points ya calculados + Fibonacci

  // Próxima resistencia real por encima del precio
  const nextRes = resistances.filter(r => r.price > cur).sort((a, b) => a.price - b.price)[0];
  const nextSup = supports.filter(s => s.price < cur).sort((a, b) => b.price - a.price)[0];

  // Fibonacci: niveles clave relativos al precio
  const fibAbove = [fib.r_236, fib.r_382, fib.r_500, fib.ext_1618]
    .filter(v => v && v > cur * 1.01).sort((a, b) => a - b);
  const fibBelow = [fib.r_618, fib.r_786, fib.r_1000]
    .filter(v => v && v < cur * 0.99).sort((a, b) => b - a);

  // ── PROBABILIDADES REALES ────────────────────────────────
  // Calculamos la probabilidad real basada en:
  // - Score técnico (señales alcistas vs bajistas)
  // - Stage de Weinstein (contexto de mercado)
  // - Posición relativa en rango 52 semanas
  // - Tendencia de MA30

  // Base: 50% neutral
  let rawBullProb = 50;

  // Score técnico: cada punto vale ~3%
  rawBullProb += totalScore * 3;

  // Stage de Weinstein: ajuste fundamental
  if (stage === 2) rawBullProb += 15;      // Stage 2: alcista
  else if (stage === 4) rawBullProb -= 15; // Stage 4: bajista
  else if (stage === 3) rawBullProb -= 8;  // Stage 3: distribución
  // Stage 1: neutral, no ajusta

  // Tendencia MA30
  if (ma30_slope > 0.05) rawBullProb += 8;       // MA30 subiendo fuerte
  else if (ma30_slope > 0.01) rawBullProb += 4;  // MA30 subiendo leve
  else if (ma30_slope < -0.05) rawBullProb -= 8; // MA30 bajando fuerte
  else if (ma30_slope < -0.01) rawBullProb -= 4; // MA30 bajando leve

  // Posición en rango 52s (momentum de largo plazo)
  const range52 = high52w - low52w;
  const posInRange = range52 > 0 ? (cur - low52w) / range52 : 0.5;
  if (posInRange > 0.7) rawBullProb += 5;       // En parte alta del rango
  else if (posInRange < 0.3) rawBullProb -= 5;  // En parte baja del rango

  // Clamp entre 20% y 80% (nunca decimos 95% de certeza)
  const bullProb = Math.round(Math.max(20, Math.min(80, rawBullProb)));
  const bearProb = 100 - bullProb;

  // Convicción basada en diferencia
  const diff = Math.abs(bullProb - bearProb);
  const conviction = diff >= 30 ? 'Alta' : diff >= 15 ? 'Moderada' : 'Baja';
  const moreProb    = bullProb >= bearProb ? 'alcista' : 'bajista';

  // Razones para la probabilidad
  const probReasons = [];
  if (stage === 2) probReasons.push('Stage 2 Weinstein activo — tendencia alcista confirmada por MA30');
  if (stage === 4) probReasons.push('Stage 4 Weinstein — MA30 bajando con precio abajo');
  if (stage === 3) probReasons.push('Stage 3 — distribución, MA30 aplanando');
  if (totalScore >= 4) probReasons.push('Score técnico positivo: ' + bullScore + ' indicadores alcistas vs ' + bearScore + ' bajistas');
  if (totalScore <= -4) probReasons.push('Score técnico negativo: ' + bearScore + ' indicadores bajistas vs ' + bullScore + ' alcistas');
  if (ma30_slope > 0.02) probReasons.push('MA30 con pendiente alcista — fondo de mercado favorable');
  if (ma30_slope < -0.02) probReasons.push('MA30 con pendiente bajista — fondo de mercado desfavorable');
  if (posInRange > 0.7) probReasons.push('Precio en zona alta de su rango anual — momentum de largo plazo positivo');
  if (posInRange < 0.3) probReasons.push('Precio en zona baja del rango anual — posible acumulación o riesgo de caída');

  // ── CONSTRUIR RESPUESTA POR HORIZONTE ───────────────────

  return {
    bullProb, bearProb, conviction, moreProb, probReasons,
    dailyVolPct: +dailyVolPct.toFixed(2),
    ma30Slope: +(ma30_slope * 100).toFixed(2), // % por 60 días
    posInRange52: +(posInRange * 100).toFixed(1),

    horizons: [
      {
        id: '1m',
        label: '1 Mes',
        period: '~30 días',
        icon: '📅',
        color: '#3b82f6',
        desc: 'Mediano plazo corto. Refleja el próximo movimiento significativo.',

        // Método 1: Canal de precio
        chan_up: chan30_up,
        chan_dn: chan30_dn,
        chan_center: +channelCenter30d.toFixed(4),

        // Método 2: Bollinger / Volatilidad histórica
        vol_up: bb30_up,
        vol_dn: bb30_dn,
        vol_pct: +(dailyVolPct * Math.sqrt(30)).toFixed(1),

        // Método 3: Nivel técnico más cercano
        tech_up: nextRes ? +nextRes.price.toFixed(4) : (fibAbove[0] ? +fibAbove[0].toFixed(4) : null),
        tech_dn: nextSup ? +nextSup.price.toFixed(4) : (fibBelow[0] ? +fibBelow[0].toFixed(4) : null),
        tech_up_label: nextRes ? 'Resistencia pivot (' + nextRes.touches + '× tocada)' : 'Fibonacci ' + (fibAbove[0] ? fibAbove[0].toFixed(0) : ''),
        tech_dn_label: nextSup ? 'Soporte pivot (' + nextSup.touches + '× tocado)' : 'Fibonacci',

        // Promedio de los 3 métodos
        consensus_up: +((chan30_up + bb30_up + (nextRes?.price || chan30_up)) / 3).toFixed(4),
        consensus_dn: +((chan30_dn + bb30_dn + (nextSup?.price || chan30_dn)) / 3).toFixed(4),

        strategy_notes: [
          'Canal de precio (Weinstein): basado en amplitud histórica del canal en 90 días (' + (channelAmp90 * 100).toFixed(1) + '% de amplitud real)',
          'Volatilidad histórica: desv estándar de retornos log de 90 días × √30 = ' + (dailyVolPct * Math.sqrt(30)).toFixed(1) + '% de rango esperado',
          nextRes ? 'Próxima resistencia real en $' + nextRes.price + ' (' + nextRes.touches + ' contactos históricos en 90 días)' : 'Sin resistencia clara en datos recientes',
        ],
      },
      {
        id: '3m',
        label: '3 Meses',
        period: '~90 días',
        icon: '📆',
        color: '#8b5cf6',
        desc: 'Mediano plazo. Un trimestre completo captura un ciclo de mercado.',

        chan_up: chan90_up,
        chan_dn: chan90_dn,
        chan_center: +channelCenter90d.toFixed(4),

        vol_up: bb90_up,
        vol_dn: bb90_dn,
        vol_pct: +(dailyVolPct * Math.sqrt(90)).toFixed(1),

        tech_up: e50 ? +e50.toFixed(4) : (fibAbove[1] || fibAbove[0] ? +(fibAbove[1] || fibAbove[0]).toFixed(4) : null),
        tech_dn: fibBelow[0] ? +fibBelow[0].toFixed(4) : null,
        tech_up_label: e50 ? (cur < e50 ? 'EMA50 como resistencia dinámica' : 'EMA50 como soporte dinámica — objetivo si hay pullback') : 'Fibonacci 38.2%',
        tech_dn_label: 'Fibonacci 61.8% — retroceso dorado',

        consensus_up: +((chan90_up + bb90_up + (e50 > cur ? e50 : chan90_up)) / 3).toFixed(4),
        consensus_dn: +((chan90_dn + bb90_dn + (fibBelow[0] || chan90_dn)) / 3).toFixed(4),

        strategy_notes: [
          'Canal de precio: amplitud de 90 días (' + (channelAmp90 * 100).toFixed(1) + '%) proyectada en la tendencia actual de MA30',
          'Volatilidad histórica × √90 = ' + (dailyVolPct * Math.sqrt(90)).toFixed(1) + '% de rango esperado en 3 meses',
          'EMA50 en $' + (e50 ? e50.toFixed(2) : '—') + ' es el imán institucional de mediano plazo más relevante',
          'Fibonacci 61.8% ($' + fib.r_618 + ') es el soporte/resistencia más importante en correcciones de mediano plazo',
        ],
      },
      {
        id: '6-12m',
        label: '6-12 Meses',
        period: '~180-365 días',
        icon: '🗓️',
        color: '#f97316',
        desc: 'Largo plazo. Captura el ciclo completo de tendencia primaria.',

        chan_up: chan180_up,
        chan_dn: chan180_dn,
        chan_center: +channelCenter180d.toFixed(4),

        vol_up: bb180_up,
        vol_dn: bb180_dn,
        vol_pct: +(dailyVolPct * Math.sqrt(180)).toFixed(1),

        tech_up: fib.ext_1618 ? +fib.ext_1618.toFixed(4) : high52w,
        tech_dn: e200 ? +e200.toFixed(4) : (fib.r_786 ? +fib.r_786.toFixed(4) : null),
        tech_up_label: 'Extensión Fibonacci 161.8% — objetivo en tendencias alcistas fuertes',
        tech_dn_label: e200 ? 'EMA200 — soporte de largo plazo fundamental' : 'Fibonacci 78.6% — soporte profundo',

        consensus_up: +((chan180_up + bb180_up + (fib.ext_1618 || chan180_up)) / 3).toFixed(4),
        consensus_dn: +((chan180_dn + bb180_dn + (e200 || fib.r_786 || chan180_dn)) / 3).toFixed(4),

        strategy_notes: [
          'Canal de precio: amplitud de 180 días (' + (channelAmp180 * 100).toFixed(1) + '%) sobre tendencia de MA30 a 6 meses',
          'Volatilidad histórica × √180 = ' + (dailyVolPct * Math.sqrt(180)).toFixed(1) + '% de rango esperado en 6 meses',
          'Extensión Fibonacci 161.8% ($' + (fib.ext_1618 || '—') + ') es el objetivo clásico en mercados alcistas (Stage 2 Weinstein)',
          'EMA200 ($' + (e200 ? e200.toFixed(2) : '—') + ') es el soporte/resistencia más importante de largo plazo',
          'Weinstein Stage ' + (stage === 2 ? '2 activo — tendencia de fondo alcista favorece el escenario de suba' : stage === 4 ? '4 activo — tendencia de fondo bajista domina' : stage + ' — esperar definición'),
        ],
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────
// ANÁLISIS DE FUTUROS — Multi-Timeframe 4H + 12H
// Estrategia: ICT Confluencia + Estructura de Mercado (BOS/CHoCH)
// Fuentes: Bybit → Binance → KuCoin
// ─────────────────────────────────────────────────────────

async function fetchKlinesFutures(sym, interval, limit) {
  const pair = sym.endsWith('USDT') ? sym : sym + 'USDT';

  // 1. KuCoin — funciona desde servidores cloud, buena disponibilidad
  try {
    const kuInterval = {'4h':'4hour','12h':'12hour','1h':'1hour','15m':'15min'}[interval]||'4hour';
    const end = Math.floor(Date.now()/1000);
    // KuCoin max por request es 1500, calculamos startAt según intervalo
    const secPerBar = {'4h':14400,'12h':43200,'1h':3600,'15m':900}[interval]||14400;
    const start = end - limit * secPerBar * 1.1;
    const r = await fetch(
      `https://api.kucoin.com/api/v1/market/candles?type=${kuInterval}&symbol=${pair.replace('USDT','-USDT')}&startAt=${Math.floor(start)}&endAt=${end}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (r.ok) {
      const d = await r.json();
      if (d?.data?.length > 10) {
        // KuCoin devuelve [time, open, close, high, low, volume, amount] en orden DESC
        return d.data.reverse().map(k=>({
          time:+k[0]*1000, open:+k[1], close:+k[2], high:+k[3], low:+k[4], volume:+k[5]
        }));
      }
    }
  } catch {}

  // 2. OKX — otra exchange sin restricción de IPs cloud
  try {
    const okxBar = {'4h':'4H','12h':'12H','1h':'1H','15m':'15m'}[interval]||'4H';
    const r = await fetch(
      `https://www.okx.com/api/v5/market/candles?instId=${pair.replace('USDT','-USDT-SWAP')}&bar=${okxBar}&limit=${limit}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (r.ok) {
      const d = await r.json();
      if (d?.data?.length > 10) {
        return d.data.reverse().map(k=>({
          time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5]
        }));
      }
    }
  } catch {}

  // 3. Bybit como tercer intento
  try {
    const bybitInterval = {'4h':'240','12h':'720','1h':'60','15m':'15'}[interval]||'240';
    const r = await fetch(
      `https://api.bybit.com/v5/market/kline?category=linear&symbol=${pair}&interval=${bybitInterval}&limit=${limit}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (r.ok) {
      const d = await r.json();
      const list = d?.result?.list;
      if (list?.length > 10) return list.reverse().map(k=>({
        time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5]
      }));
    }
  } catch {}

  // 4. Binance Spot (sin restricción para endpoints públicos básicos)
  try {
    const binInterval = {'4h':'4h','12h':'12h','1h':'1h','15m':'15m'}[interval]||'4h';
    const r = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${binInterval}&limit=${limit}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (r.ok) {
      const d = await r.json();
      if (Array.isArray(d) && d.length > 10) return d.map(k=>({
        time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5]
      }));
    }
  } catch {}

  return null;
}

async function analyzeFutures(sym) {
  const ticker = sym.toUpperCase().replace('USDT','');
  const pair = ticker + 'USDT';

  // Fetch 4H (50 velas = ~8 días) y 12H (30 velas = ~15 días) en paralelo
  const [bars4h, bars12h] = await Promise.all([
    fetchKlinesFutures(ticker, '4h', 50),
    fetchKlinesFutures(ticker, '12h', 30),
  ]);

  if (!bars4h || bars4h.length < 20) {
    return { error: `No se encontraron datos para ${ticker}. Usá el símbolo base sin USDT (ej: BTC, ETH, SOL, BNB, XRP).`, ticker };
  }

  const n4 = bars4h.length;
  const c4 = bars4h.map(b=>b.close), h4 = bars4h.map(b=>b.high), l4 = bars4h.map(b=>b.low), v4 = bars4h.map(b=>b.volume);
  const cur = c4[n4-1];
  const prev = c4[n4-2];

  // ── INDICADORES 4H ──────────────────────────────────────
  const ema21_4h  = calcEMA(c4, 21);
  const ema8_4h   = calcEMA(c4, 8);
  const macd4h    = calcMACD(c4);
  const rsi4h     = calcRSI(c4, 14);
  const atr4h_arr = calcATR(bars4h, 14);
  const stoch4h   = calcStochastic(h4, l4, c4, 14, 3);
  const vol20_4h  = calcSMA(v4, 20);

  const e21  = ema21_4h[n4-1];
  const e8   = ema8_4h[n4-1];
  const e8p  = ema8_4h[n4-2];
  const macdLine4h = macd4h.macdLine[n4-1];
  const macdSig4h  = macd4h.signalLine[n4-1];
  const macdHist4h = macd4h.histogram[n4-1];
  const macdHistP  = macd4h.histogram[n4-2];
  const rsi4hCur   = rsi4h[n4-1];
  const atr4h      = atr4h_arr[n4-1] || cur * 0.01;
  const stochK4h   = stoch4h.k[n4-1];
  const stochD4h   = stoch4h.d[n4-1];
  const volCur4h   = v4[n4-1];
  const volAvg4h   = vol20_4h[n4-1];
  const volRatio4h = volAvg4h > 0 ? volCur4h / volAvg4h : 1;

  // ── CONTEXTO 12H ────────────────────────────────────────
  let ctx12h = null;
  if (bars12h && bars12h.length >= 15) {
    const n12 = bars12h.length;
    const c12 = bars12h.map(b=>b.close), h12 = bars12h.map(b=>b.high), l12 = bars12h.map(b=>b.low);
    const ema50_12 = calcEMA(c12, 21); // 21 en 12H ≈ 50 en 4H
    const ema21_12 = calcEMA(c12, 10);
    const rsi12    = calcRSI(c12, 14);

    // VWAP de las últimas 10 velas 12H
    let cumTPV = 0, cumVol = 0;
    bars12h.slice(-10).forEach(b => { const tp=(b.high+b.low+b.close)/3; cumTPV+=tp*b.volume; cumVol+=b.volume; });
    const vwap12h = cumVol > 0 ? cumTPV / cumVol : cur;

    // Estructura de mercado 12H: Higher Highs / Lower Lows
    const hhLast = Math.max(...h12.slice(-6));
    const llLast = Math.min(...l12.slice(-6));
    const hhPrev = Math.max(...h12.slice(-12, -6));
    const llPrev = Math.min(...l12.slice(-12, -6));
    const bullStructure = hhLast > hhPrev && llLast > llPrev; // HH + HL
    const bearStructure = hhLast < hhPrev && llLast < llPrev; // LH + LL

    ctx12h = {
      ema50: ema50_12[n12-1],
      ema21: ema21_12[n12-1],
      rsi:   rsi12[n12-1],
      vwap:  +vwap12h.toFixed(4),
      bullStructure,
      bearStructure,
      aboveVwap: cur > vwap12h,
      cur: c12[n12-1],
    };
  }

  // ── ESTRUCTURA DE MERCADO 4H (BOS/CHoCH) ────────────────
  // Break of Structure (BOS): precio rompe máximo/mínimo previo
  // Change of Character (CHoCH): señal temprana de reversión
  const swingLookback = 8;
  const swingHigh4h = Math.max(...h4.slice(n4-swingLookback-1, n4-1));
  const swingLow4h  = Math.min(...l4.slice(n4-swingLookback-1, n4-1));
  const prevSwingH  = Math.max(...h4.slice(n4-swingLookback*2-1, n4-swingLookback-1));
  const prevSwingL  = Math.min(...l4.slice(n4-swingLookback*2-1, n4-swingLookback-1));

  const bos_bull  = cur > swingHigh4h && prev <= swingHigh4h; // Rompe resistencia → BOS alcista
  const bos_bear  = cur < swingLow4h  && prev >= swingLow4h;  // Rompe soporte → BOS bajista
  const choch_bull = swingLow4h > prevSwingL && cur > e21;    // HL + sobre EMA21 → CHoCH alcista
  const choch_bear = swingHigh4h < prevSwingH && cur < e21;   // LH + bajo EMA21 → CHoCH bajista

  // ── ORDER BLOCK 4H ──────────────────────────────────────
  // Última vela bajista antes de impulso alcista fuerte, y viceversa
  let bullOB = null, bearOB = null;
  for (let i = n4-3; i > Math.max(n4-20, 1); i--) {
    const b = bars4h[i];
    const fwd = c4[Math.min(i+3, n4-1)];
    if (!bullOB && b.close < b.open && (fwd-b.close)/atr4h > 1.5)
      bullOB = { high:+b.open.toFixed(4), low:+b.close.toFixed(4), mid:+((b.open+b.close)/2).toFixed(4) };
    if (!bearOB && b.close > b.open && (b.close-fwd)/atr4h > 1.5)
      bearOB = { high:+b.close.toFixed(4), low:+b.open.toFixed(4), mid:+((b.open+b.close)/2).toFixed(4) };
    if (bullOB && bearOB) break;
  }

  // ── FAIR VALUE GAP 4H ───────────────────────────────────
  let bullFVG = null, bearFVG = null;
  for (let i = 1; i < n4-1; i++) {
    const gapSize = Math.abs(l4[i+1] - h4[i-1]);
    if (!bullFVG && l4[i+1] > h4[i-1] && gapSize > atr4h*0.3)
      bullFVG = { low:+h4[i-1].toFixed(4), high:+l4[i+1].toFixed(4) };
    if (!bearFVG && h4[i+1] < l4[i-1] && gapSize > atr4h*0.3)
      bearFVG = { high:+l4[i-1].toFixed(4), low:+h4[i+1].toFixed(4) };
  }

  // ── SCORING (pesos por importancia) ─────────────────────
  let bull = 0, bear = 0;
  const sigs = [];

  // Peso 4: Estructura de mercado (señal primaria)
  if (bos_bull)  { sigs.push({icon:'🏗️',text:'BOS alcista en 4H: precio rompió el swing high $'+swingHigh4h.toFixed(2)+'. Cambio de estructura confirmado.',bull:true,w:4}); bull+=4; }
  if (bos_bear)  { sigs.push({icon:'🏗️',text:'BOS bajista en 4H: precio rompió el swing low $'+swingLow4h.toFixed(2)+'. Estructura bajista confirmada.',bull:false,w:4}); bear+=4; }
  if (choch_bull && !bos_bull) { sigs.push({icon:'🔄',text:'CHoCH alcista: Higher Low formado + precio sobre EMA21. Posible inicio de reversión al alza.',bull:true,w:3}); bull+=3; }
  if (choch_bear && !bos_bear) { sigs.push({icon:'🔄',text:'CHoCH bajista: Lower High formado + precio bajo EMA21. Posible inicio de reversión a la baja.',bull:false,w:3}); bear+=3; }

  // Peso 3: Contexto 12H
  if (ctx12h) {
    if (ctx12h.bullStructure) { sigs.push({icon:'📊',text:'Contexto 12H alcista: Higher Highs + Higher Lows. La tendencia de fondo favorece largos.',bull:true,w:3}); bull+=3; }
    if (ctx12h.bearStructure) { sigs.push({icon:'📊',text:'Contexto 12H bajista: Lower Highs + Lower Lows. La tendencia de fondo favorece cortos.',bull:false,w:3}); bear+=3; }
    if (ctx12h.aboveVwap) { sigs.push({icon:'🏦',text:'Precio sobre VWAP 12H ($'+ctx12h.vwap+'). Zona institucional compradora.',bull:true,w:2}); bull+=2; }
    else { sigs.push({icon:'🏦',text:'Precio bajo VWAP 12H ($'+ctx12h.vwap+'). Zona institucional vendedora.',bull:false,w:2}); bear+=2; }
  }

  // Peso 3: Order Block (solo si el precio está en él)
  const inBullOB = bullOB && cur >= bullOB.low*0.998 && cur <= bullOB.high*1.003;
  const inBearOB = bearOB && cur >= bearOB.low*0.997 && cur <= bearOB.high*1.002;
  if (inBullOB) { sigs.push({icon:'📦',text:'Precio en Order Block alcista ($'+bullOB.low+'-$'+bullOB.high+'). Zona de demanda institucional activa.',bull:true,w:3}); bull+=3; }
  if (inBearOB) { sigs.push({icon:'📦',text:'Precio en Order Block bajista ($'+bearOB.low+'-$'+bearOB.high+'). Zona de oferta institucional activa.',bull:false,w:3}); bear+=3; }

  // Peso 2: MACD 4H
  const macdCross_up   = macdLine4h > macdSig4h  && macd4h.macdLine[n4-2] <= macd4h.signalLine[n4-2];
  const macdCross_down = macdLine4h < macdSig4h  && macd4h.macdLine[n4-2] >= macd4h.signalLine[n4-2];
  if (macdCross_up)   { sigs.push({icon:'⚡',text:'MACD cruzó al alza en 4H. Cambio de momentum a positivo.',bull:true,w:2}); bull+=2; }
  if (macdCross_down) { sigs.push({icon:'⚡',text:'MACD cruzó a la baja en 4H. Cambio de momentum a negativo.',bull:false,w:2}); bear+=2; }
  else if (macdLine4h > macdSig4h && macdHist4h > macdHistP) { sigs.push({icon:'📈',text:'MACD sobre señal y acelerando en 4H. Momentum alcista en expansión.',bull:true,w:1}); bull+=1; }
  else if (macdLine4h < macdSig4h && macdHist4h < macdHistP) { sigs.push({icon:'📉',text:'MACD bajo señal y acelerando en 4H. Momentum bajista en expansión.',bull:false,w:1}); bear+=1; }

  // Peso 2: EMA 8 > 21 (tendencia 4H)
  if (e8 > e21 && cur > e8) { sigs.push({icon:'📈',text:'Precio > EMA8 > EMA21 en 4H. Alineación alcista en el timeframe operativo.',bull:true,w:2}); bull+=2; }
  else if (e8 < e21 && cur < e8) { sigs.push({icon:'📉',text:'Precio < EMA8 < EMA21 en 4H. Alineación bajista en el timeframe operativo.',bull:false,w:2}); bear+=2; }

  // Peso 2: FVG (solo si precio está dentro)
  const inBullFVG = bullFVG && cur >= bullFVG.low && cur <= bullFVG.high;
  const inBearFVG = bearFVG && cur >= bearFVG.low && cur <= bearFVG.high;
  if (inBullFVG) { sigs.push({icon:'🕳️',text:'Precio en Fair Value Gap alcista ($'+bullFVG.low+'-$'+bullFVG.high+'). Imbalance institucional — tendencia a rellenar al alza.',bull:true,w:2}); bull+=2; }
  if (inBearFVG) { sigs.push({icon:'🕳️',text:'Precio en Fair Value Gap bajista ($'+bearFVG.low+'-$'+bearFVG.high+'). Imbalance — tendencia a rellenar a la baja.',bull:false,w:2}); bear+=2; }

  // Peso 1: RSI y volumen
  if (rsi4hCur < 35)       { sigs.push({icon:'🟢',text:'RSI 4H en '+rsi4hCur.toFixed(1)+' — sobreventa. Posible rebote técnico.',bull:true,w:1}); bull+=1; }
  else if (rsi4hCur > 65)  { sigs.push({icon:'🔴',text:'RSI 4H en '+rsi4hCur.toFixed(1)+' — sobrecompra. Riesgo de corrección.',bull:false,w:1}); bear+=1; }
  if (stochK4h < 20 && stochK4h > stochD4h) { sigs.push({icon:'⚡',text:'Estocástico 4H: K('+stochK4h.toFixed(0)+') cruzó arriba de D en sobreventa. Señal de entrada.',bull:true,w:1}); bull+=1; }
  if (stochK4h > 80 && stochK4h < stochD4h) { sigs.push({icon:'⚡',text:'Estocástico 4H: K('+stochK4h.toFixed(0)+') cruzó abajo de D en sobrecompra. Señal de salida.',bull:false,w:1}); bear+=1; }
  if (volRatio4h > 1.5 && cur > prev) { sigs.push({icon:'🔊',text:'Volumen '+volRatio4h.toFixed(1)+'x promedio en vela verde. Impulso alcista con convicción.',bull:true,w:1}); bull+=1; }
  if (volRatio4h > 1.5 && cur < prev) { sigs.push({icon:'🔊',text:'Volumen '+volRatio4h.toFixed(1)+'x promedio en vela roja. Impulso bajista con convicción.',bull:false,w:1}); bear+=1; }

  // ── DECISIÓN: requiere señal de estructura (BOS/CHoCH/OB) ──
  const score = bull - bear;
  const hasPrimBull = bos_bull || choch_bull || inBullOB || (ctx12h?.bullStructure && bull > bear);
  const hasPrimBear = bos_bear || choch_bear || inBearOB || (ctx12h?.bearStructure && bear > bull);
  let dir = 'NEUTRAL';
  if (score >= 4 && hasPrimBull) dir = 'LONG';
  else if (score <= -4 && hasPrimBear) dir = 'SHORT';

  // ── ENTRY / TP / SL — Metodología ICT correcta ──────────
  //
  // REGLAS:
  // 1. ENTRY: precio actual o mitad del OB si precio está en él
  // 2. SL: bajo el OB/swing low (LONG) o sobre el OB/swing high (SHORT)
  //    con un buffer de 0.5×ATR para evitar stop hunts
  //    Mínimo garantizado: 1×ATR (nunca SL más chico que eso)
  // 3. TP: se calculan sobre NIVELES NATURALES (swing highs/lows)
  //    TP1 → swing high/low inmediato = R:R mínimo 1.5:1
  //    TP2 → swing high/low extendido = R:R mínimo 3:1
  //    Si no hay swing natural, se usa ATR×2.5 y ATR×5
  // 4. Leverage: max 1% de liquidación sobre SL distance

  const atrPct = (atr4h / cur) * 100;
  let entry = cur, tp1 = null, tp2 = null, sl = null, rr1 = null, rr2 = null;

  // Swing highs/lows reales de las últimas 20 velas 4H (excluyendo actual)
  const recentHighs = h4.slice(n4-20, n4-1);
  const recentLows  = l4.slice(n4-20, n4-1);
  // Filtramos niveles significativos (alejados del precio actual)
  const swHighsAbove = recentHighs.filter(v => v > cur * 1.002).sort((a,b)=>a-b);
  const swLowsBelow  = recentLows.filter(v => v < cur * 0.998).sort((a,b)=>b-a);

  if (dir === 'LONG') {
    // Entry: si precio está en el OB, entrar en el mid del OB; si no, precio actual
    entry = (inBullOB && bullOB) ? +((bullOB.high + bullOB.low) / 2).toFixed(4) : +cur.toFixed(4);

    // SL: bajo el OB (si existe y es significativo) o bajo swing low + buffer 0.5×ATR
    let rawSL;
    if (inBullOB && bullOB && (entry - bullOB.low) >= atr4h * 0.8) {
      // OB tiene suficiente ancho — SL bajo el OB con buffer
      rawSL = bullOB.low - atr4h * 0.5;
    } else if (swLowsBelow.length > 0) {
      // Swing low más cercano por debajo
      rawSL = swLowsBelow[0] - atr4h * 0.3;
    } else {
      // Fallback: 1.5×ATR bajo entry
      rawSL = entry - atr4h * 1.5;
    }
    // Garantizar SL mínimo de 1×ATR
    sl = +Math.min(rawSL, entry - atr4h).toFixed(4);

    const risk = entry - sl;

    // TP1: primer swing high por encima (mínimo 1.5R)
    const tp1Natural = swHighsAbove.find(h => h >= entry + risk * 1.5);
    tp1 = tp1Natural ? +tp1Natural.toFixed(4) : +(entry + risk * 2).toFixed(4);

    // TP2: swing high más lejano (mínimo 3R) o ATR×5
    const tp2Natural = swHighsAbove.find(h => h >= entry + risk * 3);
    tp2 = tp2Natural ? +tp2Natural.toFixed(4) : +(entry + risk * 3.5).toFixed(4);

    rr1 = +((tp1 - entry) / risk).toFixed(2);
    rr2 = +((tp2 - entry) / risk).toFixed(2);

  } else if (dir === 'SHORT') {
    entry = (inBearOB && bearOB) ? +((bearOB.high + bearOB.low) / 2).toFixed(4) : +cur.toFixed(4);

    let rawSL;
    if (inBearOB && bearOB && (bearOB.high - entry) >= atr4h * 0.8) {
      rawSL = bearOB.high + atr4h * 0.5;
    } else if (swHighsAbove.length > 0) {
      rawSL = swHighsAbove[0] + atr4h * 0.3;
    } else {
      rawSL = entry + atr4h * 1.5;
    }
    // Garantizar SL mínimo de 1×ATR
    sl = +Math.max(rawSL, entry + atr4h).toFixed(4);

    const risk = sl - entry;

    const tp1Natural = swLowsBelow.find(l => l <= entry - risk * 1.5);
    tp1 = tp1Natural ? +tp1Natural.toFixed(4) : +(entry - risk * 2).toFixed(4);

    const tp2Natural = swLowsBelow.find(l => l <= entry - risk * 3);
    tp2 = tp2Natural ? +tp2Natural.toFixed(4) : +(entry - risk * 3.5).toFixed(4);

    rr1 = +((entry - tp1) / risk).toFixed(2);
    rr2 = +((entry - tp2) / risk).toFixed(2);
  }

  // Leverage: basado en distancia real del SL (nunca liquidar antes del SL)
  // Si SL está a 2% → max leverage 30x; si está a 5% → max 15x
  const slDistPct = sl ? Math.abs(entry - sl) / entry * 100 : atrPct;
  // Max leverage tal que liquidación sea a 1.5× la distancia del SL
  const maxLevByRisk = Math.floor(100 / (slDistPct * 1.5));
  // Cap conservador según volatilidad del activo
  const volCap = atrPct > 4 ? 3 : atrPct > 2.5 ? 5 : atrPct > 1.5 ? 8 : atrPct > 0.8 ? 12 : 15;
  const leverage = Math.min(maxLevByRisk, volCap, 20);
  const liqDist = +(100 / leverage).toFixed(1);

  let verdict, verdictColor, verdictIcon;
  if (dir === 'LONG')  { verdict='LONG';    verdictColor='#22c55e'; verdictIcon='🟢'; }
  else if (dir === 'SHORT') { verdict='SHORT';   verdictColor='#ef4444'; verdictIcon='🔴'; }
  else                 { verdict='SIN SETUP'; verdictColor='#eab308'; verdictIcon='⚖️'; }

  return {
    ticker, pair, mode:'futures',
    currentPrice: +cur.toFixed(6),
    verdict, verdictColor, verdictIcon,
    score, bullScore:bull, bearScore:bear, dir,
    entry, tp1, tp2, sl, rr1, rr2, leverage, liqDist, slDistPct: +slDistPct.toFixed(2),
    atr4h: +atr4h.toFixed(6), atrPct: +atrPct.toFixed(3),
    indicators4h: {
      ema8: e8?+e8.toFixed(4):null, ema21: e21?+e21.toFixed(4):null,
      rsi: +rsi4hCur.toFixed(1),
      macdLine: macdLine4h?+macdLine4h.toFixed(4):null,
      macdHist: macdHist4h?+macdHist4h.toFixed(4):null,
      stochK: +stochK4h.toFixed(1),
      volRatio: +volRatio4h.toFixed(2),
    },
    structure: { bos_bull, bos_bear, choch_bull, choch_bear },
    bullOB, bearOB, bullFVG, bearFVG,
    inBullOB, inBearOB, inBullFVG, inBearFVG,
    ctx12h,
    signals: sigs.sort((a,b)=>b.w-a.w),
    analyzedAt: new Date().toISOString(),
  };
}

// Exportar la función para usarla desde el handler
module.exports._analyzeFutures = analyzeFutures;