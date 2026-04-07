/**
 * api/signals.js
 * Calcula señales de trading usando análisis técnico clásico:
 * - Stage Analysis (Stan Weinstein)
 * - EMA 20/50/200 (tendencia)
 * - RSI 14 (momentum, Welles Wilder)
 * - Volumen vs promedio 20d
 * - Soporte/Resistencia (máximos y mínimos 52 semanas)
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
    const prices = await fetchHistoricalPrices(ticker, type);
    if (!prices || prices.length < 60) {
      return res.status(200).json({ error: 'Datos insuficientes para analizar', ticker });
    }

    const signal = analyzeSignals(prices, ticker);
    return res.status(200).json(signal);
  } catch (err) {
    console.error('Signals error:', err);
    return res.status(500).json({ error: String(err), ticker });
  }
};

// ── FETCH PRECIOS HISTÓRICOS ──────────────────────────────────────────────────

const CGIDS = {
  BTC:'bitcoin',ETH:'ethereum',SOL:'solana',ADA:'cardano',DOT:'polkadot',
  AVAX:'avalanche-2',MATIC:'matic-network',LINK:'chainlink',XRP:'ripple',
  LTC:'litecoin',BNB:'binancecoin',DOGE:'dogecoin',SHIB:'shiba-inu',
  UNI:'uniswap',ATOM:'cosmos',NEAR:'near',OP:'optimism',ARB:'arbitrum',
  WIF:'dogwifcoin',PEPE:'pepe',TON:'the-open-network',SUI:'sui',
  THETA:'theta-token',SAND:'the-sandbox',MANA:'decentraland',AXS:'axie-infinity',
  FIL:'filecoin',ICP:'internet-computer',HBAR:'hedera-hashgraph',
  ALGO:'algorand',XLM:'stellar',BCH:'bitcoin-cash',AAVE:'aave',
  RUNE:'thorchain',FTM:'fantom',GRT:'the-graph',
};
const CRYPTO_SET = new Set(Object.keys(CGIDS));

async function fetchHistoricalPrices(ticker, type) {
  const sym = ticker.toUpperCase();
  const isCrypto = type === 'cripto' || CRYPTO_SET.has(sym);

  if (isCrypto) {
    return fetchCryptoPrices(sym);
  }
  // Para CEDEARs usamos el ticker con .BA para datos de BYMA
  const yahooSym = type === 'cedear' ? `${sym}.BA` : sym;
  return fetchStockPrices(yahooSym);
}

async function fetchStockPrices(sym) {
  for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const r = await fetch(`${base}/v8/finance/chart/${sym}?interval=1d&range=1y`);
      if (!r.ok) continue;
      const d = await r.json();
      const result = d?.chart?.result?.[0];
      if (!result) continue;

      const timestamps = result.timestamp || [];
      const quotes = result.indicators?.quote?.[0] || {};
      const closes  = quotes.close  || [];
      const highs   = quotes.high   || [];
      const lows    = quotes.low    || [];
      const volumes = quotes.volume || [];

      const bars = [];
      for (let i = 0; i < timestamps.length; i++) {
        if (closes[i] != null && volumes[i] != null) {
          bars.push({
            date:   new Date(timestamps[i] * 1000).toISOString().split('T')[0],
            close:  closes[i],
            high:   highs[i]   || closes[i],
            low:    lows[i]    || closes[i],
            volume: volumes[i] || 0,
          });
        }
      }
      return bars;
    } catch { continue; }
  }
  return null;
}

async function fetchCryptoPrices(sym) {
  const id = CGIDS[sym] || sym.toLowerCase();
  try {
    const r = await fetch(
      `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=365&interval=daily`
    );
    if (!r.ok) return null;
    const d = await r.json();
    const prices  = d.prices         || [];
    const volumes = d.total_volumes  || [];

    return prices.map((p, i) => ({
      date:   new Date(p[0]).toISOString().split('T')[0],
      close:  p[1],
      high:   p[1],
      low:    p[1],
      volume: volumes[i]?.[1] || 0,
    }));
  } catch { return null; }
}

// ── INDICADORES TÉCNICOS ──────────────────────────────────────────────────────

function ema(data, period) {
  const k = 2 / (period + 1);
  const result = [];
  let emaPrev = null;
  for (let i = 0; i < data.length; i++) {
    if (emaPrev === null) {
      if (i < period - 1) { result.push(null); continue; }
      // Primer EMA = SMA de los primeros `period` valores
      const slice = data.slice(0, period);
      emaPrev = slice.reduce((a, b) => a + b, 0) / period;
      result.push(emaPrev);
    } else {
      emaPrev = data[i] * k + emaPrev * (1 - k);
      result.push(emaPrev);
    }
  }
  return result;
}

function rsi(closes, period = 14) {
  const result = new Array(period).fill(null);
  let avgGain = 0, avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period; i < closes.length; i++) {
    if (i > period) {
      const diff = closes[i] - closes[i - 1];
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? Math.abs(diff) : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push(100 - 100 / (1 + rs));
  }
  return result;
}

function sma(data, period) {
  return data.map((_, i) => {
    if (i < period - 1) return null;
    const slice = data.slice(i - period + 1, i + 1).filter(v => v != null);
    return slice.length === period ? slice.reduce((a, b) => a + b, 0) / period : null;
  });
}

// ── ANÁLISIS PRINCIPAL ────────────────────────────────────────────────────────

function analyzeSignals(bars, ticker) {
  const closes  = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume);
  const highs   = bars.map(b => b.high);
  const lows    = bars.map(b => b.low);
  const n       = closes.length;

  const ema20  = ema(closes, 20);
  const ema50  = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsi14  = rsi(closes, 14);
  const vol20  = sma(volumes, 20);

  const cur      = closes[n - 1];
  const e20      = ema20[n - 1];
  const e50      = ema50[n - 1];
  const e200     = ema200[n - 1];
  const rsiCur   = rsi14[n - 1];
  const rsiPrev  = rsi14[n - 2];
  const volCur   = volumes[n - 1];
  const volAvg   = vol20[n - 1];
  const volRatio = volAvg > 0 ? volCur / volAvg : 1;

  const high52w = Math.max(...highs.slice(-252));
  const low52w  = Math.min(...lows.slice(-252));
  const distFromHigh = ((cur - high52w) / high52w) * 100;
  const distFromLow  = ((cur - low52w)  / low52w)  * 100;

  // ── STAN WEINSTEIN STAGE ──
  // Stage 1: base (precio cerca de MA30, lateralización)
  // Stage 2: avance (precio sobre MA30, MA30 subiendo) ← compra
  // Stage 3: techo (precio cerca de MA30 pero MA30 aplanando)
  // Stage 4: declive (precio bajo MA30) ← venta
  let stage = 1, stageName = 'Base (Stage 1)';
  if (e50) {
    const e50Prev = ema50[n - 5] || e50;
    const ma50Rising  = e50 > e50Prev;
    const ma50Falling = e50 < e50Prev;
    if (cur > e50 && ma50Rising)  { stage = 2; stageName = 'Avance (Stage 2)'; }
    if (cur > e50 && !ma50Rising) { stage = 3; stageName = 'Distribución (Stage 3)'; }
    if (cur < e50 && ma50Falling) { stage = 4; stageName = 'Declive (Stage 4)'; }
  }

  // ── SEÑALES ──
  const signals = [];
  let score = 0; // positivo = alcista, negativo = bajista

  // Tendencia EMA
  if (e20 && e50 && e200) {
    if (cur > e20 && e20 > e50 && e50 > e200) {
      signals.push({ icon: '📈', text: 'Tendencia alcista: precio sobre EMA20 > EMA50 > EMA200', bull: true });
      score += 3;
    } else if (cur < e20 && e20 < e50 && e50 < e200) {
      signals.push({ icon: '📉', text: 'Tendencia bajista: precio bajo EMA20 < EMA50 < EMA200', bull: false });
      score -= 3;
    } else if (cur > e50) {
      signals.push({ icon: '🔼', text: `Precio sobre EMA50 ($${e50.toFixed(2)}) — sesgo alcista`, bull: true });
      score += 1;
    } else {
      signals.push({ icon: '🔽', text: `Precio bajo EMA50 ($${e50.toFixed(2)}) — sesgo bajista`, bull: false });
      score -= 1;
    }
  }

  // RSI
  if (rsiCur != null) {
    if (rsiCur < 30) {
      signals.push({ icon: '⚡', text: `RSI ${rsiCur.toFixed(1)} — sobreventa, posible rebote`, bull: true });
      score += 2;
    } else if (rsiCur > 70) {
      signals.push({ icon: '⚠️', text: `RSI ${rsiCur.toFixed(1)} — sobrecompra, posible corrección`, bull: false });
      score -= 2;
    } else if (rsiCur > 50 && rsiCur > rsiPrev) {
      signals.push({ icon: '✅', text: `RSI ${rsiCur.toFixed(1)} — momentum alcista (>50 y subiendo)`, bull: true });
      score += 1;
    } else if (rsiCur < 50 && rsiCur < rsiPrev) {
      signals.push({ icon: '🔴', text: `RSI ${rsiCur.toFixed(1)} — momentum bajista (<50 y cayendo)`, bull: false });
      score -= 1;
    } else {
      signals.push({ icon: '➡️', text: `RSI ${rsiCur.toFixed(1)} — zona neutral`, bull: null });
    }
  }

  // Volumen
  if (volRatio > 1.5 && cur > (closes[n - 2] || cur)) {
    signals.push({ icon: '🔊', text: `Volumen ${volRatio.toFixed(1)}x por encima del promedio con vela verde — señal de fuerza`, bull: true });
    score += 1;
  } else if (volRatio > 1.5 && cur < (closes[n - 2] || cur)) {
    signals.push({ icon: '🔊', text: `Volumen ${volRatio.toFixed(1)}x por encima del promedio con vela roja — señal de debilidad`, bull: false });
    score -= 1;
  }

  // Stage Weinstein
  if (stage === 2) {
    signals.push({ icon: '🟢', text: `Stage 2 (Weinstein): tendencia alcista confirmada — zona de compra`, bull: true });
    score += 2;
  } else if (stage === 4) {
    signals.push({ icon: '🔴', text: `Stage 4 (Weinstein): tendencia bajista confirmada — evitar o vender`, bull: false });
    score -= 2;
  } else if (stage === 1) {
    signals.push({ icon: '⏳', text: `Stage 1 (Weinstein): base/acumulación — esperar ruptura al alza`, bull: null });
  } else if (stage === 3) {
    signals.push({ icon: '⚠️', text: `Stage 3 (Weinstein): distribución — reducir exposición`, bull: false });
    score -= 1;
  }

  // Proximidad a máximo/mínimo 52 semanas
  if (distFromHigh > -5) {
    signals.push({ icon: '🏔️', text: `Cerca del máximo de 52 semanas ($${high52w.toFixed(2)}) — resistencia clave`, bull: null });
  } else if (distFromLow < 10) {
    signals.push({ icon: '🪃', text: `Cerca del mínimo de 52 semanas ($${low52w.toFixed(2)}) — soporte clave`, bull: true });
    score += 1;
  }

  // ── VEREDICTO FINAL ──
  let verdict, verdictColor, verdictIcon;
  if (score >= 5)       { verdict = 'Compra fuerte';  verdictColor = '#22c55e'; verdictIcon = '🟢'; }
  else if (score >= 2)  { verdict = 'Compra';          verdictColor = '#86efac'; verdictIcon = '🔼'; }
  else if (score >= -1) { verdict = 'Neutral';          verdictColor = '#eab308'; verdictIcon = '⚖️'; }
  else if (score >= -4) { verdict = 'Venta';            verdictColor = '#fca5a5'; verdictIcon = '🔽'; }
  else                  { verdict = 'Venta fuerte';    verdictColor = '#ef4444'; verdictIcon = '🔴'; }

  return {
    ticker,
    currentPrice: cur,
    verdict, verdictColor, verdictIcon, score,
    stage: stageName,
    ema20: e20, ema50: e50, ema200: e200,
    rsi: rsiCur,
    volRatio,
    high52w, low52w,
    distFromHigh, distFromLow,
    signals,
    analyzedAt: new Date().toISOString(),
    barsCount: n,
  };
}