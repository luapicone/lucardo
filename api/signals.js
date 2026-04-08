/**
 * api/signals.js
 * Señales de trading — dos modos:
 *
 * SCALPING (Futuros 5m/15m):
 *   Técnica: Liquidity Sweep + Order Block (ICT/Smart Money, Michael Huddleston)
 *   + EMA 9/21 + VWAP + ATR para TP/SL/Leverage dinámico
 *   Fuente: Binance Futures API (pública, sin key)
 *
 * SPOT (Swing/Posicional):
 *   Técnica: Stage Analysis (Stan Weinstein) + EMA 20/50/200 + RSI 14
 *   Fuente: CoinGecko + Yahoo Finance
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
      const result = await analyzeScalp(ticker.toUpperCase());
      return res.status(200).json(result);
    } else {
      const result = await analyzeSpot(ticker.toUpperCase());
      return res.status(200).json(result);
    }
  } catch (err) {
    console.error('Signals error:', err);
    return res.status(500).json({ error: String(err), ticker });
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// SCALPING — Liquidity Sweep + Order Block + EMA 9/21 + VWAP + ATR
// ══════════════════════════════════════════════════════════════════════════════

async function analyzeScalp(sym) {
  // Binance usa USDT pairs para futuros
  const pair = sym.endsWith('USDT') ? sym : `${sym}USDT`;

  // Traemos datos en dos timeframes: 5m (scalp) y 15m (contexto)
  const [bars5m, bars15m] = await Promise.all([
    fetchBinanceKlines(pair, '5m', 100),
    fetchBinanceKlines(pair, '15m', 100),
  ]);

  if (!bars5m || bars5m.length < 50) {
    return { error: `No se encontraron datos para ${sym} en Binance Futures. Verificá que sea un par de futuros válido (ej: BTC, ETH, SOL).`, ticker: sym };
  }

  const closes5  = bars5m.map(b => b.close);
  const highs5   = bars5m.map(b => b.high);
  const lows5    = bars5m.map(b => b.low);
  const volumes5 = bars5m.map(b => b.volume);
  const n = closes5.length;

  const cur = closes5[n - 1];

  // ── INDICADORES ──────────────────────────────────────────────────────────
  const ema9  = ema(closes5, 9);
  const ema21 = ema(closes5, 21);
  const atr14 = atr(highs5, lows5, closes5, 14);
  const rsi14 = rsi(closes5, 14);
  const vwap  = calcVWAP(bars5m);

  const e9   = ema9[n - 1];
  const e21  = ema21[n - 1];
  const atrCur = atr14[n - 1];
  const rsiCur = rsi14[n - 1];
  const rsiPrev = rsi14[n - 2];

  // ── LIQUIDITY SWEEP ───────────────────────────────────────────────────────
  // Detecta si la vela reciente barrió un mínimo/máximo previo y revirtió
  const recentHigh = Math.max(...highs5.slice(n - 20, n - 1));
  const recentLow  = Math.min(...lows5.slice(n - 20, n - 1));
  const lastHigh   = highs5[n - 1];
  const lastLow    = lows5[n - 1];
  const lastClose  = closes5[n - 1];
  const lastOpen   = bars5m[n - 1].open;

  // Sweep alcista: vela que rompió mínimos pero cerró por encima → liquidó shorts → rebote
  const bullSweep = lastLow < recentLow && lastClose > recentLow && lastClose > lastOpen;
  // Sweep bajista: vela que rompió máximos pero cerró por debajo → liquidó longs → caída
  const bearSweep = lastHigh > recentHigh && lastClose < recentHigh && lastClose < lastOpen;

  // ── ORDER BLOCK (OB) ──────────────────────────────────────────────────────
  // OB alcista: última vela bajista antes de un movimiento alcista fuerte
  // OB bajista: última vela alcista antes de un movimiento bajista fuerte
  let bullOB = null, bearOB = null;
  for (let i = n - 5; i > n - 20; i--) {
    if (!bullOB) {
      const isBearCandle = bars5m[i].close < bars5m[i].open;
      const nextMove = closes5[Math.min(i + 3, n - 1)] - bars5m[i].close;
      if (isBearCandle && nextMove > atrCur * 0.5) {
        bullOB = { high: bars5m[i].open, low: bars5m[i].close, idx: i };
      }
    }
    if (!bearOB) {
      const isBullCandle = bars5m[i].close > bars5m[i].open;
      const nextMove = bars5m[i].close - closes5[Math.min(i + 3, n - 1)];
      if (isBullCandle && nextMove > atrCur * 0.5) {
        bearOB = { high: bars5m[i].close, low: bars5m[i].open, idx: i };
      }
    }
    if (bullOB && bearOB) break;
  }

  // ── DIRECCIÓN EMA ─────────────────────────────────────────────────────────
  const emaAlcista = e9 > e21 && cur > e9;
  const emaBajista = e9 < e21 && cur < e9;

  // ── VWAP ──────────────────────────────────────────────────────────────────
  const sobreVWAP = cur > vwap;
  const bajoVWAP  = cur < vwap;

  // ── SCORE Y SEÑALES ───────────────────────────────────────────────────────
  const signals = [];
  let score = 0;
  let direction = 'NEUTRAL';

  // EMA tendencia
  if (emaAlcista) {
    signals.push({ icon: '📈', text: `EMA 9 (${e9.toFixed(4)}) sobre EMA 21 (${e21.toFixed(4)}) — tendencia alcista en 5m`, bull: true });
    score += 2;
  } else if (emaBajista) {
    signals.push({ icon: '📉', text: `EMA 9 (${e9.toFixed(4)}) bajo EMA 21 (${e21.toFixed(4)}) — tendencia bajista en 5m`, bull: false });
    score -= 2;
  }

  // VWAP
  if (sobreVWAP) {
    signals.push({ icon: '🏦', text: `Precio sobre VWAP ($${vwap.toFixed(4)}) — zona institucional alcista`, bull: true });
    score += 1;
  } else if (bajoVWAP) {
    signals.push({ icon: '🏦', text: `Precio bajo VWAP ($${vwap.toFixed(4)}) — zona institucional bajista`, bull: false });
    score -= 1;
  }

  // Liquidity Sweep
  if (bullSweep) {
    signals.push({ icon: '🌊', text: `Liquidity Sweep alcista — barrió mínimos ($${recentLow.toFixed(4)}) y revirtió, liquidando shorts`, bull: true });
    score += 3;
  } else if (bearSweep) {
    signals.push({ icon: '🌊', text: `Liquidity Sweep bajista — barrió máximos ($${recentHigh.toFixed(4)}) y revirtió, liquidando longs`, bull: false });
    score -= 3;
  }

  // Order Block
  if (bullOB && cur >= bullOB.low && cur <= bullOB.high * 1.005) {
    signals.push({ icon: '📦', text: `Precio en Order Block alcista ($${bullOB.low.toFixed(4)}-$${bullOB.high.toFixed(4)}) — zona de demanda institucional`, bull: true });
    score += 2;
  }
  if (bearOB && cur >= bearOB.low * 0.995 && cur <= bearOB.high) {
    signals.push({ icon: '📦', text: `Precio en Order Block bajista ($${bearOB.low.toFixed(4)}-$${bearOB.high.toFixed(4)}) — zona de oferta institucional`, bull: false });
    score -= 2;
  }

  // RSI momentum
  if (rsiCur < 35 && rsiCur > rsiPrev) {
    signals.push({ icon: '⚡', text: `RSI ${rsiCur.toFixed(1)} — sobreventa con recuperación, momentum alcista`, bull: true });
    score += 2;
  } else if (rsiCur > 65 && rsiCur < rsiPrev) {
    signals.push({ icon: '⚡', text: `RSI ${rsiCur.toFixed(1)} — sobrecompra con debilitamiento, momentum bajista`, bull: false });
    score -= 2;
  } else if (rsiCur > 50) {
    signals.push({ icon: '📊', text: `RSI ${rsiCur.toFixed(1)} — zona alcista`, bull: true });
    score += 1;
  } else {
    signals.push({ icon: '📊', text: `RSI ${rsiCur.toFixed(1)} — zona bajista`, bull: false });
    score -= 1;
  }

  // Contexto 15m
  if (bars15m && bars15m.length >= 21) {
    const c15 = bars15m.map(b => b.close);
    const e21_15 = ema(c15, 21);
    const cur15 = c15[c15.length - 1];
    const e21cur = e21_15[e21_15.length - 1];
    if (cur15 > e21cur) {
      signals.push({ icon: '🕰️', text: `Contexto 15m alcista — precio sobre EMA21 en timeframe mayor`, bull: true });
      score += 1;
    } else {
      signals.push({ icon: '🕰️', text: `Contexto 15m bajista — precio bajo EMA21 en timeframe mayor`, bull: false });
      score -= 1;
    }
  }

  // ── DIRECCIÓN FINAL ───────────────────────────────────────────────────────
  if (score >= 4)       direction = 'LONG';
  else if (score <= -4) direction = 'SHORT';
  else                  direction = 'NEUTRAL — esperar mejor setup';

  // ── TP / SL / LEVERAGE (basados en ATR) ──────────────────────────────────
  // ATR multipliers: scalping conservador (no exponerse más de 1.5x ATR en SL)
  const atrMult_sl = 1.2;   // SL = 1.2 × ATR (conservador para 5m)
  const atrMult_tp = 2.0;   // TP = 2.0 × ATR → ratio R:R de 1:1.67

  let entry = cur, tp = null, sl = null, leverage = null, rr = null;

  if (direction === 'LONG') {
    // Entry: precio actual o pullback al OB/EMA9
    const supportEntry = bullOB ? Math.max(bullOB.high, e9) : e9;
    entry = Math.min(cur, supportEntry * 1.001);
    sl    = entry - atrCur * atrMult_sl;
    tp    = entry + atrCur * atrMult_tp;
    rr    = (tp - entry) / (entry - sl);

    // Leverage: basado en volatilidad ATR%
    // Si ATR% > 2% → max 5x, si < 0.5% → max 20x
    const atrPct = (atrCur / cur) * 100;
    leverage = atrPct > 3 ? 3 : atrPct > 2 ? 5 : atrPct > 1 ? 10 : atrPct > 0.5 ? 15 : 20;
    leverage = Math.min(leverage, 20); // cap 20x
  } else if (direction === 'SHORT') {
    const resistEntry = bearOB ? Math.min(bearOB.low, e9) : e9;
    entry = Math.max(cur, resistEntry * 0.999);
    sl    = entry + atrCur * atrMult_sl;
    tp    = entry - atrCur * atrMult_tp;
    rr    = (entry - tp) / (sl - entry);

    const atrPct = (atrCur / cur) * 100;
    leverage = atrPct > 3 ? 3 : atrPct > 2 ? 5 : atrPct > 1 ? 10 : atrPct > 0.5 ? 15 : 20;
    leverage = Math.min(leverage, 20);
  }

  // Veredicto
  let verdict, verdictColor, verdictIcon;
  if (direction === 'LONG')                               { verdict = 'LONG'; verdictColor = '#22c55e'; verdictIcon = '🟢'; }
  else if (direction === 'SHORT')                         { verdict = 'SHORT'; verdictColor = '#ef4444'; verdictIcon = '🔴'; }
  else                                                    { verdict = 'NEUTRAL'; verdictColor = '#eab308'; verdictIcon = '⚖️'; }

  return {
    ticker: sym, pair, mode: 'scalp',
    currentPrice: cur,
    verdict, verdictColor, verdictIcon, score, direction,
    entry: entry ? +entry.toFixed(6) : null,
    tp:    tp    ? +tp.toFixed(6)    : null,
    sl:    sl    ? +sl.toFixed(6)    : null,
    leverage,
    rr:    rr    ? +rr.toFixed(2)    : null,
    atr:   atrCur ? +atrCur.toFixed(6) : null,
    rsi: rsiCur ? +rsiCur.toFixed(1) : null,
    ema9: e9   ? +e9.toFixed(6)  : null,
    ema21: e21 ? +e21.toFixed(6) : null,
    vwap: vwap ? +vwap.toFixed(6) : null,
    bullSweep, bearSweep,
    bullOB, bearOB,
    signals,
    timeframe: '5m',
    analyzedAt: new Date().toISOString(),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// SPOT — Stage Analysis + EMA 20/50/200 + RSI 14
// ══════════════════════════════════════════════════════════════════════════════

async function analyzeSpot(sym) {
  // Detectar si es cripto o acción/CEDEAR
  const CGIDS = {
    BTC:'bitcoin',ETH:'ethereum',SOL:'solana',ADA:'cardano',DOT:'polkadot',
    AVAX:'avalanche-2',MATIC:'matic-network',LINK:'chainlink',XRP:'ripple',
    LTC:'litecoin',BNB:'binancecoin',DOGE:'dogecoin',SHIB:'shiba-inu',
    UNI:'uniswap',ATOM:'cosmos',NEAR:'near',OP:'optimism',ARB:'arbitrum',
    WIF:'dogwifcoin',PEPE:'pepe',TON:'the-open-network',SUI:'sui',
    THETA:'theta-token',SAND:'the-sandbox',MANA:'decentraland',AXS:'axie-infinity',
    FIL:'filecoin',ICP:'internet-computer',HBAR:'hedera-hashgraph',
    ALGO:'algorand',XLM:'stellar',BCH:'bitcoin-cash',AAVE:'aave',
    RUNE:'thorchain',FTM:'fantom',GRT:'the-graph',APT:'aptos',INJ:'injective-protocol',
    TIA:'celestia',SEI:'sei-network',DYDX:'dydx',LDO:'lido-dao',
    MKR:'maker',SNX:'synthetix-network-token',CRV:'curve-dao-token',
    FLOW:'flow',KAVA:'kava',ZEC:'zcash',DASH:'dash',XMR:'monero',XTZ:'tezos',
  };
  const CRYPTO_SET = new Set(Object.keys(CGIDS));
  const isCrypto = CRYPTO_SET.has(sym);

  let bars;
  if (isCrypto) {
    const id = CGIDS[sym] || sym.toLowerCase();
    bars = await fetchCGHistory(id);
  } else {
    bars = await fetchYahooHistory(sym);
  }

  if (!bars || bars.length < 60) {
    return { error: `Datos insuficientes para ${sym}`, ticker: sym };
  }

  const closes  = bars.map(b => b.close);
  const highs   = bars.map(b => b.high || b.close);
  const lows    = bars.map(b => b.low  || b.close);
  const volumes = bars.map(b => b.volume || 0);
  const n = closes.length;
  const cur = closes[n - 1];

  const ema20  = ema(closes, 20);
  const ema50  = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsi14  = rsi(closes, 14);
  const vol20  = sma(volumes, 20);

  const e20 = ema20[n-1], e50 = ema50[n-1], e200 = ema200[n-1];
  const rsiCur = rsi14[n-1], rsiPrev = rsi14[n-2];
  const volCur = volumes[n-1], volAvg = vol20[n-1];
  const volRatio = volAvg > 0 ? volCur / volAvg : 1;

  const high52w = Math.max(...highs.slice(-252));
  const low52w  = Math.min(...lows.slice(-252));
  const distFromHigh = ((cur - high52w) / high52w) * 100;
  const distFromLow  = ((cur - low52w)  / low52w)  * 100;

  // Stage Weinstein
  let stage = 1, stageName = 'Base (Stage 1)';
  if (e50) {
    const e50Prev = ema50[n - 5] || e50;
    const rising  = e50 > e50Prev;
    if (cur > e50 && rising)  { stage = 2; stageName = 'Avance (Stage 2)'; }
    if (cur > e50 && !rising) { stage = 3; stageName = 'Distribución (Stage 3)'; }
    if (cur < e50 && !rising) { stage = 4; stageName = 'Declive (Stage 4)'; }
  }

  const signals = [];
  let score = 0;

  if (e20 && e50 && e200) {
    if (cur > e20 && e20 > e50 && e50 > e200) {
      signals.push({ icon: '📈', text: 'Tendencia perfecta alcista: precio > EMA20 > EMA50 > EMA200', bull: true }); score += 3;
    } else if (cur < e20 && e20 < e50 && e50 < e200) {
      signals.push({ icon: '📉', text: 'Tendencia perfecta bajista: precio < EMA20 < EMA50 < EMA200', bull: false }); score -= 3;
    } else if (cur > e50) {
      signals.push({ icon: '🔼', text: `Precio sobre EMA50 ($${e50.toFixed(4)}) — sesgo alcista`, bull: true }); score += 1;
    } else {
      signals.push({ icon: '🔽', text: `Precio bajo EMA50 ($${e50.toFixed(4)}) — sesgo bajista`, bull: false }); score -= 1;
    }
  }

  if (rsiCur != null) {
    if (rsiCur < 30) { signals.push({ icon: '⚡', text: `RSI ${rsiCur.toFixed(1)} — sobreventa`, bull: true }); score += 2; }
    else if (rsiCur > 70) { signals.push({ icon: '⚠️', text: `RSI ${rsiCur.toFixed(1)} — sobrecompra`, bull: false }); score -= 2; }
    else if (rsiCur > 50 && rsiCur > rsiPrev) { signals.push({ icon: '✅', text: `RSI ${rsiCur.toFixed(1)} — momentum alcista`, bull: true }); score += 1; }
    else { signals.push({ icon: '🔴', text: `RSI ${rsiCur.toFixed(1)} — momentum bajista`, bull: false }); score -= 1; }
  }

  if (volRatio > 1.5 && cur > closes[n-2]) { signals.push({ icon: '🔊', text: `Volumen ${volRatio.toFixed(1)}x — fuerza compradora`, bull: true }); score += 1; }
  else if (volRatio > 1.5) { signals.push({ icon: '🔊', text: `Volumen ${volRatio.toFixed(1)}x — fuerza vendedora`, bull: false }); score -= 1; }

  if (stage === 2) { signals.push({ icon: '🟢', text: 'Stage 2 Weinstein: tendencia alcista confirmada', bull: true }); score += 2; }
  else if (stage === 4) { signals.push({ icon: '🔴', text: 'Stage 4 Weinstein: tendencia bajista confirmada', bull: false }); score -= 2; }
  else if (stage === 1) { signals.push({ icon: '⏳', text: 'Stage 1 Weinstein: acumulación, esperar ruptura', bull: null }); }
  else if (stage === 3) { signals.push({ icon: '⚠️', text: 'Stage 3 Weinstein: distribución, reducir exposición', bull: false }); score -= 1; }

  if (distFromHigh > -5) { signals.push({ icon: '🏔️', text: `Cerca del máximo 52s ($${high52w.toFixed(4)}) — resistencia`, bull: null }); }
  else if (distFromLow < 10) { signals.push({ icon: '🪃', text: `Cerca del mínimo 52s ($${low52w.toFixed(4)}) — soporte`, bull: true }); score += 1; }

  let verdict, verdictColor, verdictIcon;
  if (score >= 5)       { verdict = 'Compra fuerte';  verdictColor = '#22c55e'; verdictIcon = '🟢'; }
  else if (score >= 2)  { verdict = 'Compra';          verdictColor = '#86efac'; verdictIcon = '🔼'; }
  else if (score >= -1) { verdict = 'Neutral';          verdictColor = '#eab308'; verdictIcon = '⚖️'; }
  else if (score >= -4) { verdict = 'Venta';            verdictColor = '#fca5a5'; verdictIcon = '🔽'; }
  else                  { verdict = 'Venta fuerte';    verdictColor = '#ef4444'; verdictIcon = '🔴'; }

  return {
    ticker: sym, mode: 'spot',
    currentPrice: cur,
    verdict, verdictColor, verdictIcon, score,
    stage: stageName,
    ema20: e20, ema50: e50, ema200: e200,
    rsi: rsiCur, volRatio,
    high52w, low52w, distFromHigh, distFromLow,
    signals,
    analyzedAt: new Date().toISOString(),
    barsCount: n,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// DATA SOURCES
// ══════════════════════════════════════════════════════════════════════════════

async function fetchBinanceKlines(pair, interval, limit = 100) {
  try {
    const r = await fetch(
      `https://fapi.binance.com/fapi/v1/klines?symbol=${pair}&interval=${interval}&limit=${limit}`
    );
    if (!r.ok) return null;
    const d = await r.json();
    if (!Array.isArray(d)) return null;
    return d.map(k => ({
      time:   k[0],
      open:   parseFloat(k[1]),
      high:   parseFloat(k[2]),
      low:    parseFloat(k[3]),
      close:  parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  } catch { return null; }
}

async function fetchCGHistory(id) {
  try {
    const r = await fetch(
      `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=365&interval=daily`
    );
    if (!r.ok) return null;
    const d = await r.json();
    const prices = d.prices || [];
    const vols   = d.total_volumes || [];
    return prices.map((p, i) => ({
      date: new Date(p[0]).toISOString().split('T')[0],
      close: p[1], high: p[1], low: p[1],
      volume: vols[i]?.[1] || 0,
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
      const ts = result.timestamp || [];
      const q  = result.indicators?.quote?.[0] || {};
      return ts.map((t, i) => ({
        date: new Date(t * 1000).toISOString().split('T')[0],
        close: q.close?.[i], high: q.high?.[i], low: q.low?.[i], volume: q.volume?.[i] || 0,
      })).filter(b => b.close != null);
    } catch { continue; }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// INDICADORES TÉCNICOS
// ══════════════════════════════════════════════════════════════════════════════

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
    const slice = data.slice(i - period + 1, i + 1).filter(v => v != null);
    return slice.length === period ? slice.reduce((a, b) => a + b, 0) / period : null;
  });
}

function calcVWAP(bars) {
  let cumTPV = 0, cumVol = 0;
  for (const b of bars) {
    const tp = (b.high + b.low + b.close) / 3;
    cumTPV += tp * b.volume;
    cumVol += b.volume;
  }
  return cumVol > 0 ? cumTPV / cumVol : bars[bars.length - 1].close;
}