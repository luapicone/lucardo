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

  const { ticker, type } = req.body || {};
  if (!ticker) return res.status(400).json({ error: 'Ticker requerido' });

  try {
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
    action, targets, scenarios,
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