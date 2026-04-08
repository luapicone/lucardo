/**
 * api/signals.js — v3
 *
 * SCALP (5m): ICT/Smart Money — Sweep + OB + FVG + EMA 9/21 + VWAP + ATR
 *   Fuente: Bybit → Binance → KuCoin
 *
 * SPOT: Weinstein Stage + EMA + RSI + Fibonacci + Proyección realista
 *   Proyección: combina regresión lineal + ATR volatility bands + niveles Fibonacci
 *   (evita el problema de extrapolar tendencias extremas)
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
    if (mode === 'scalp') return res.status(200).json(await analyzeScalp(ticker.toUpperCase()));
    return res.status(200).json(await analyzeSpot(ticker.toUpperCase()));
  } catch (err) {
    console.error('Signals error:', err);
    return res.status(500).json({ error: String(err), ticker });
  }
};

// ═══════════════════════════════════════════════════════════
// DATA SOURCES
// ═══════════════════════════════════════════════════════════

async function fetchKlines(sym, interval, limit) {
  const pair = sym.endsWith('USDT') ? sym : `${sym}USDT`;

  // 1. Bybit (no restringe cloud IPs)
  try {
    const bi = { '5m':'5','15m':'15','1h':'60','4h':'240','1d':'D' }[interval]||'5';
    const r = await fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${pair}&interval=${bi}&limit=${limit}`);
    if (r.ok) {
      const d = await r.json();
      const list = d?.result?.list;
      if (list?.length > 10) {
        return list.reverse().map(k=>({
          time:Number(k[0]),open:parseFloat(k[1]),high:parseFloat(k[2]),
          low:parseFloat(k[3]),close:parseFloat(k[4]),volume:parseFloat(k[5]),
        }));
      }
    }
  } catch {}

  // 2. Binance Spot
  try {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`);
    if (r.ok) {
      const d = await r.json();
      if (Array.isArray(d) && d.length > 10)
        return d.map(k=>({time:k[0],open:parseFloat(k[1]),high:parseFloat(k[2]),low:parseFloat(k[3]),close:parseFloat(k[4]),volume:parseFloat(k[5])}));
    }
  } catch {}

  // 3. KuCoin
  try {
    const ki = {'5m':'5min','15m':'15min','1h':'1hour','1d':'1day'}[interval]||'5min';
    const end = Math.floor(Date.now()/1000);
    const start = end - limit*300;
    const r = await fetch(`https://api.kucoin.com/api/v1/market/candles?type=${ki}&symbol=${sym}-USDT&startAt=${start}&endAt=${end}`);
    if (r.ok) {
      const d = await r.json();
      if (d?.data?.length>10)
        return d.data.reverse().map(k=>({time:Number(k[0])*1000,open:parseFloat(k[1]),close:parseFloat(k[2]),high:parseFloat(k[3]),low:parseFloat(k[4]),volume:parseFloat(k[5])}));
    }
  } catch {}

  return null;
}

const CGIDS={BTC:'bitcoin',ETH:'ethereum',SOL:'solana',ADA:'cardano',DOT:'polkadot',AVAX:'avalanche-2',MATIC:'matic-network',POL:'matic-network',LINK:'chainlink',XRP:'ripple',LTC:'litecoin',BNB:'binancecoin',DOGE:'dogecoin',SHIB:'shiba-inu',UNI:'uniswap',ATOM:'cosmos',NEAR:'near',OP:'optimism',ARB:'arbitrum',WIF:'dogwifcoin',PEPE:'pepe',TON:'the-open-network',SUI:'sui',APT:'aptos',INJ:'injective-protocol',TIA:'celestia',SEI:'sei-network',THETA:'theta-token',TFUEL:'theta-fuel',SAND:'the-sandbox',MANA:'decentraland',AXS:'axie-infinity',FIL:'filecoin',ICP:'internet-computer',VET:'vechain',HBAR:'hedera-hashgraph',ALGO:'algorand',XLM:'stellar',ETC:'ethereum-classic',BCH:'bitcoin-cash',AAVE:'aave',MKR:'maker',LDO:'lido-dao',RUNE:'thorchain',FTM:'fantom',GRT:'the-graph',FLOW:'flow',KAVA:'kava',ZEC:'zcash',DASH:'dash',XMR:'monero',XTZ:'tezos',SNX:'synthetix-network-token',CRV:'curve-dao-token',SUSHI:'sushi',YFI:'yearn-finance',COMP:'compound-governance-token',BAT:'basic-attention-token',ONE:'harmony',ENJ:'enjincoin',CHZ:'chiliz',OCEAN:'ocean-protocol',ANKR:'ankr',RENDER:'render-token',FET:'fetch-ai',WLD:'worldcoin-wld',PYTH:'pyth-network',STX:'blockstack'};
const CRYPTO_SET=new Set(Object.keys(CGIDS));

async function fetchCGHistory(id) {
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=365&interval=daily`);
    if (!r.ok) return null;
    const d = await r.json();
    const prices=d.prices||[], vols=d.total_volumes||[];
    return prices.map((p,i)=>({date:new Date(p[0]).toISOString().split('T')[0],close:p[1],high:p[1]*1.005,low:p[1]*0.995,volume:vols[i]?.[1]||0}));
  } catch { return null; }
}

async function fetchYahooHistory(sym) {
  for (const base of ['https://query1.finance.yahoo.com','https://query2.finance.yahoo.com']) {
    try {
      const r = await fetch(`${base}/v8/finance/chart/${sym}?interval=1d&range=1y`);
      if (!r.ok) continue;
      const d = await r.json();
      const res=d?.chart?.result?.[0];
      if (!res) continue;
      const ts=res.timestamp||[], q=res.indicators?.quote?.[0]||{};
      return ts.map((t,i)=>({date:new Date(t*1000).toISOString().split('T')[0],close:q.close?.[i],high:q.high?.[i]||q.close?.[i],low:q.low?.[i]||q.close?.[i],volume:q.volume?.[i]||0})).filter(b=>b.close!=null);
    } catch { continue; }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
// INDICADORES
// ═══════════════════════════════════════════════════════════

function ema(data, p) {
  const k=2/(p+1); const result=[]; let prev=null;
  for (let i=0;i<data.length;i++) {
    if (prev===null) { if(i<p-1){result.push(null);continue;} prev=data.slice(0,p).reduce((a,b)=>a+b,0)/p; result.push(prev); continue; }
    prev=data[i]*k+prev*(1-k); result.push(prev);
  }
  return result;
}

function rsi(closes, p=14) {
  const result=new Array(p).fill(null); let ag=0,al=0;
  for(let i=1;i<=p;i++){const d=closes[i]-closes[i-1];if(d>0)ag+=d;else al+=Math.abs(d);}
  ag/=p; al/=p;
  for(let i=p;i<closes.length;i++){
    if(i>p){const d=closes[i]-closes[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?Math.abs(d):0))/p;}
    result.push(al===0?100:100-100/(1+ag/al));
  }
  return result;
}

function atr(highs, lows, closes, p=14) {
  const trs=highs.map((h,i)=>i===0?h-lows[i]:Math.max(h-lows[i],Math.abs(h-closes[i-1]),Math.abs(lows[i]-closes[i-1])));
  return sma(trs, p);
}

function sma(data, p) {
  return data.map((_,i)=>{
    if(i<p-1)return null;
    const sl=data.slice(i-p+1,i+1).filter(v=>v!=null);
    return sl.length===p?sl.reduce((a,b)=>a+b,0)/p:null;
  });
}

function calcVWAP(bars) {
  let cumTPV=0,cumVol=0;
  for(const b of bars){const tp=(b.high+b.low+b.close)/3;cumTPV+=tp*b.volume;cumVol+=b.volume;}
  return cumVol>0?cumTPV/cumVol:bars[bars.length-1].close;
}

// Regresión lineal — devuelve slope, r-cuadrado (calidad del fit) y proyecciones
function linearReg(data) {
  const n=data.length;
  const xm=(n-1)/2, ym=data.reduce((a,b)=>a+b,0)/n;
  let num=0,den=0,ssRes=0,ssTot=0;
  for(let i=0;i<n;i++){num+=(i-xm)*(data[i]-ym);den+=(i-xm)**2;}
  const slope=den!==0?num/den:0;
  const intercept=ym-slope*xm;
  for(let i=0;i<n;i++){const pred=intercept+slope*i;ssRes+=(data[i]-pred)**2;ssTot+=(data[i]-ym)**2;}
  const r2=ssTot>0?Math.max(0,1-ssRes/ssTot):0;
  return {slope,intercept,r2,
    project:(periods)=>periods.map(p=>({period:p,price:intercept+slope*(n-1+p)}))
  };
}

// Proyección realista: combina regresión + mean reversion + bandas de volatilidad
function realisticProjection(closes, horizons) {
  const n = closes.length;
  const cur = closes[n-1];

  // Volatilidad histórica (desv estándar de retornos diarios)
  const returns = closes.slice(1).map((c,i)=>Math.log(c/closes[i]));
  const meanRet = returns.reduce((a,b)=>a+b,0)/returns.length;
  const variance = returns.map(r=>(r-meanRet)**2).reduce((a,b)=>a+b,0)/returns.length;
  const dailyVol = Math.sqrt(variance); // vol diaria en log-returns

  // Regresión sobre los últimos 90 días para tendencia
  const reg = linearReg(closes.slice(-Math.min(90,n)));
  // Cap slope: si r2 < 0.3 (tendencia débil), reducir slope al 30%
  const confidenceMult = reg.r2 < 0.3 ? 0.3 : reg.r2 < 0.6 ? 0.6 : 1.0;
  const effectiveSlope = reg.slope * confidenceMult;

  return horizons.map(days=>{
    // Precio esperado por tendencia (ajustado por confianza)
    const trendPrice = cur + effectiveSlope * days;
    // Bandas de volatilidad (1.5 sigma para el 87% de los casos)
    const totalVol = dailyVol * Math.sqrt(days) * cur;
    const upper = trendPrice + totalVol * 1.5;
    const lower = trendPrice - totalVol * 1.5;
    return {
      period: days,
      price: Math.max(trendPrice, cur * 0.01), // no puede ser negativo
      upper: Math.max(upper, cur * 0.01),
      lower: Math.max(lower, cur * 0.01),
      confidence: reg.r2,
      dailyVolPct: dailyVol * 100,
    };
  });
}

function fibonacci(high, low) {
  const d=high-low;
  return {
    ext_1618:+(high+d*0.618).toFixed(6),
    r_000:   +high.toFixed(6),
    r_236:   +(high-d*0.236).toFixed(6),
    r_382:   +(high-d*0.382).toFixed(6),
    r_500:   +(high-d*0.5).toFixed(6),
    r_618:   +(high-d*0.618).toFixed(6),
    r_786:   +(high-d*0.786).toFixed(6),
    r_1000:  +low.toFixed(6),
  };
}

function findLevels(prices, n, lookback=60, type='support') {
  const slice = prices.slice(Math.max(0,n-lookback),n);
  const sorted = [...slice].sort((a,b)=>type==='support'?a-b:b-a);
  const result=[];
  let group=[sorted[0]];
  for(let i=1;i<sorted.length;i++){
    if(Math.abs(sorted[i]-group[group.length-1])/group[group.length-1]<0.01){group.push(sorted[i]);}
    else{result.push({price:group.reduce((a,b)=>a+b,0)/group.length,touches:group.length});group=[sorted[i]];}
  }
  if(group.length)result.push({price:group.reduce((a,b)=>a+b,0)/group.length,touches:group.length});
  return result.sort((a,b)=>b.touches-a.touches).slice(0,5);
}

// ═══════════════════════════════════════════════════════════
// SCALPING — ICT/Smart Money Concepts
// ═══════════════════════════════════════════════════════════

async function analyzeScalp(sym) {
  const [bars5m, bars15m] = await Promise.all([
    fetchKlines(sym, '5m', 150),
    fetchKlines(sym, '15m', 80),
  ]);

  if (!bars5m||bars5m.length<50) {
    return {error:`No se encontraron datos para ${sym}. Escribí solo el símbolo base sin USDT (BTC, ETH, SOL, BNB, XRP, DOGE, AVAX, LINK, DOT, ADA, etc.)`,ticker:sym};
  }

  const closes5=bars5m.map(b=>b.close);
  const highs5=bars5m.map(b=>b.high);
  const lows5=bars5m.map(b=>b.low);
  const n=closes5.length;
  const cur=closes5[n-1];

  const ema9arr=ema(closes5,9);
  const ema21arr=ema(closes5,21);
  const atr14arr=atr(highs5,lows5,closes5,14);
  const rsi14arr=rsi(closes5,14);
  // VWAP solo sobre las últimas 60 velas (1 sesión de 5h aprox)
  const vwap=calcVWAP(bars5m.slice(-60));

  const e9=ema9arr[n-1], e21=ema21arr[n-1];
  const atrCur=atr14arr[n-1]||(cur*0.003);
  const rsiCur=rsi14arr[n-1], rsiPrev=rsi14arr[n-2];
  const rsi3ago=rsi14arr[n-4]; // para divergencias

  // Swing high/low — busca pivot points reales
  const pivotLB=20;
  let swingHigh=Math.max(...highs5.slice(n-pivotLB,n-1));
  let swingLow=Math.min(...lows5.slice(n-pivotLB,n-1));

  // Liquidity Sweep — necesita la vela completa para confirmarse
  const lastBar=bars5m[n-1], prevBar=bars5m[n-2], prev2Bar=bars5m[n-3];
  const bodySize=Math.abs(lastBar.close-lastBar.open);
  const totalRange=lastBar.high-lastBar.low;
  const isBullEngulf=lastBar.close>lastBar.open&&lastBar.close>prevBar.open&&lastBar.open<prevBar.close;
  const isBearEngulf=lastBar.close<lastBar.open&&lastBar.close<prevBar.open&&lastBar.open>prevBar.close;

  // Sweep: wick que rompe el swing y cuerpo que cierra dentro
  const bullSweep=lastBar.low<swingLow&&lastBar.close>swingLow&&lastBar.close>lastBar.open&&bodySize>totalRange*0.4;
  const bearSweep=lastBar.high>swingHigh&&lastBar.close<swingHigh&&lastBar.close<lastBar.open&&bodySize>totalRange*0.4;

  // Order Block — vela impulsiva previa de signo contrario
  let bullOB=null, bearOB=null;
  for(let i=n-3;i>Math.max(n-30,1);i--){
    const b=bars5m[i];
    // La siguiente vela debe ser impulso en dirección contraria
    const nextClose=closes5[Math.min(i+2,n-1)];
    const prevClose=closes5[i-1];
    if(!bullOB && b.close<b.open) {
      const impulse=(nextClose-b.close)/atrCur;
      if(impulse>1.5) bullOB={high:b.open,low:b.close,mid:(b.open+b.close)/2,impulse:+impulse.toFixed(1)};
    }
    if(!bearOB && b.close>b.open) {
      const impulse=(b.close-nextClose)/atrCur;
      if(impulse>1.5) bearOB={high:b.close,low:b.open,mid:(b.open+b.close)/2,impulse:+impulse.toFixed(1)};
    }
    if(bullOB&&bearOB)break;
  }

  // Fair Value Gap
  let bullFVG=null, bearFVG=null;
  for(let i=1;i<n-1;i++){
    if(!bullFVG&&lows5[i+1]>highs5[i-1]){bullFVG={low:highs5[i-1],high:lows5[i+1]};}
    if(!bearFVG&&highs5[i+1]<lows5[i-1]){bearFVG={high:lows5[i-1],low:highs5[i+1]};}
  }

  // RSI divergencia (precio hace nuevo mínimo pero RSI no)
  const rsiDivBull=lows5[n-1]<lows5[n-6]&&rsiCur>(rsi14arr[n-6]||rsiCur);
  const rsiDivBear=highs5[n-1]>highs5[n-6]&&rsiCur<(rsi14arr[n-6]||rsiCur);

  // Contexto 15m
  let context15m=null;
  if(bars15m&&bars15m.length>=21){
    const c15=bars15m.map(b=>b.close);
    const e21_15=ema(c15,21);
    const cur15=c15[c15.length-1];
    const e21cur=e21_15[e21_15.length-1];
    context15m={bullish:cur15>e21cur,e21:e21cur,cur:cur15};
  }

  // ── SCORING con pesos diferenciados ──
  const signals=[];
  let bullPoints=0, bearPoints=0;

  // Peso 3: señales ICT primarias
  if(bullSweep){signals.push({icon:'🌊',text:`Liquidity Sweep ALCISTA — barrió stops bajo $${swingLow.toFixed(4)} y cerró arriba. Señal de acumulación institucional fuerte`,bull:true});bullPoints+=3;}
  if(bearSweep){signals.push({icon:'🌊',text:`Liquidity Sweep BAJISTA — barrió stops sobre $${swingHigh.toFixed(4)} y cerró abajo. Señal de distribución institucional fuerte`,bull:false});bearPoints+=3;}

  if(bullOB&&cur>=bullOB.low*0.998&&cur<=bullOB.high*1.005){
    signals.push({icon:'📦',text:`Order Block ALCISTA ($${bullOB.low.toFixed(4)}-$${bullOB.high.toFixed(4)}) — zona de demanda institucional con ${bullOB.impulse}x ATR de impulso posterior`,bull:true});bullPoints+=3;
  }
  if(bearOB&&cur>=bearOB.low*0.995&&cur<=bearOB.high*1.002){
    signals.push({icon:'📦',text:`Order Block BAJISTA ($${bearOB.low.toFixed(4)}-$${bearOB.high.toFixed(4)}) — zona de oferta institucional con ${bearOB.impulse}x ATR de impulso posterior`,bull:false});bearPoints+=3;
  }

  // Peso 2: confirmación
  if(e9&&e21){
    if(cur>e9&&e9>e21){signals.push({icon:'📈',text:`EMA 9 (${e9.toFixed(4)}) > EMA 21 (${e21.toFixed(4)}) — tendencia alcista en 5m confirmada`,bull:true});bullPoints+=2;}
    else if(cur<e9&&e9<e21){signals.push({icon:'📉',text:`EMA 9 (${e9.toFixed(4)}) < EMA 21 (${e21.toFixed(4)}) — tendencia bajista en 5m confirmada`,bull:false});bearPoints+=2;}
    else{signals.push({icon:'↔️',text:`EMAs entrelazadas — zona de indecisión, evitar entrar`,bull:null});}
  }

  if(bullFVG&&cur>=bullFVG.low&&cur<=bullFVG.high){signals.push({icon:'🕳️',text:`Fair Value Gap alcista ($${bullFVG.low.toFixed(4)}-$${bullFVG.high.toFixed(4)}) — imbalance por rellenar al alza`,bull:true});bullPoints+=2;}
  if(bearFVG&&cur>=bearFVG.low&&cur<=bearFVG.high){signals.push({icon:'🕳️',text:`Fair Value Gap bajista ($${bearFVG.low.toFixed(4)}-$${bearFVG.high.toFixed(4)}) — imbalance por rellenar a la baja`,bull:false});bearPoints+=2;}

  if(rsiDivBull){signals.push({icon:'⚡',text:`Divergencia alcista RSI — precio hace nuevo mínimo pero RSI no confirma. Agotamiento vendedor`,bull:true});bullPoints+=2;}
  if(rsiDivBear){signals.push({icon:'⚡',text:`Divergencia bajista RSI — precio hace nuevo máximo pero RSI no confirma. Agotamiento comprador`,bull:false});bearPoints+=2;}

  // Peso 1: contexto
  if(cur>vwap){signals.push({icon:'🏦',text:`Sobre VWAP ($${vwap.toFixed(4)}) — precio en zona institucional compradora`,bull:true});bullPoints+=1;}
  else{signals.push({icon:'🏦',text:`Bajo VWAP ($${vwap.toFixed(4)}) — precio en zona institucional vendedora`,bull:false});bearPoints+=1;}

  if(rsiCur!=null){
    if(rsiCur<35){signals.push({icon:'📊',text:`RSI ${rsiCur.toFixed(1)} — sobreventa en 5m`,bull:true});bullPoints+=1;}
    else if(rsiCur>65){signals.push({icon:'📊',text:`RSI ${rsiCur.toFixed(1)} — sobrecompra en 5m`,bull:false});bearPoints+=1;}
    else if(rsiCur>50){signals.push({icon:'📊',text:`RSI ${rsiCur.toFixed(1)} — zona de fuerza`,bull:true});bullPoints+=0.5;}
    else{signals.push({icon:'📊',text:`RSI ${rsiCur.toFixed(1)} — zona de debilidad`,bull:false});bearPoints+=0.5;}
  }

  if(context15m){
    if(context15m.bullish){signals.push({icon:'🕰️',text:`Contexto 15m alcista — confluencia con tendencia de timeframe mayor`,bull:true});bullPoints+=1;}
    else{signals.push({icon:'🕰️',text:`Contexto 15m bajista — ir long en 5m es contra tendencia mayor (mayor riesgo)`,bull:false});bearPoints+=1;}
  }

  // ── DECISIÓN: necesita ventaja CLARA ──
  const score=bullPoints-bearPoints;
  let direction='NEUTRAL';
  // Requiere al menos una señal ICT primaria (sweep o OB) para dar LONG/SHORT
  const hasPrimaryBull=(bullSweep||(bullOB&&cur>=bullOB.low*0.998&&cur<=bullOB.high*1.005)||rsiDivBull);
  const hasPrimaryBear=(bearSweep||(bearOB&&cur>=bearOB.low*0.995&&cur<=bearOB.high*1.002)||rsiDivBear);
  if(score>=3&&hasPrimaryBull)direction='LONG';
  else if(score<=-3&&hasPrimaryBear)direction='SHORT';

  // TP/SL basados en ATR + niveles naturales
  let entry=cur, tp=null, sl=null, leverage=null, rr=null;
  const atrPct=(atrCur/cur)*100;

  if(direction==='LONG'){
    // Entry: mejor precio posible (OB o precio actual)
    entry=bullOB?Math.min(cur,bullOB.high*1.001):cur;
    // SL: bajo el OB o 1.5x ATR
    sl=bullOB?bullOB.low*0.999:entry-atrCur*1.5;
    // TP: próxima resistencia o 2.5x ATR (R:R mínimo 1.5:1)
    const dist=entry-sl;
    tp=entry+Math.max(dist*1.5, atrCur*2.5);
    rr=+((tp-entry)/(entry-sl)).toFixed(2);
  } else if(direction==='SHORT'){
    entry=bearOB?Math.max(cur,bearOB.low*0.999):cur;
    sl=bearOB?bearOB.high*1.001:entry+atrCur*1.5;
    const dist=sl-entry;
    tp=entry-Math.max(dist*1.5, atrCur*2.5);
    rr=+((entry-tp)/(sl-entry)).toFixed(2);
  }

  // Leverage conservador — max exposición 1 ATR por unidad
  leverage=atrPct>4?3:atrPct>2.5?5:atrPct>1.5?8:atrPct>0.8?12:atrPct>0.4?15:20;

  let verdict,verdictColor,verdictIcon;
  if(direction==='LONG'){verdict='LONG';verdictColor='#22c55e';verdictIcon='🟢';}
  else if(direction==='SHORT'){verdict='SHORT';verdictColor='#ef4444';verdictIcon='🔴';}
  else{verdict='SIN SETUP';verdictColor='#eab308';verdictIcon='⚖️';}

  return {
    ticker:sym,pair:`${sym}USDT`,mode:'scalp',
    currentPrice:+cur.toFixed(6),
    verdict,verdictColor,verdictIcon,score:+score.toFixed(1),direction,
    entry:entry?+entry.toFixed(6):null,
    tp:tp?+tp.toFixed(6):null,
    sl:sl?+sl.toFixed(6):null,
    leverage,rr,
    atr:+atrCur.toFixed(6),
    atrPct:+atrPct.toFixed(3),
    rsi:rsiCur?+rsiCur.toFixed(1):null,
    ema9:e9?+e9.toFixed(6):null,
    ema21:e21?+e21.toFixed(6):null,
    vwap:+vwap.toFixed(6),
    bullSweep,bearSweep,bullOB,bearOB,bullFVG,bearFVG,
    rsiDivBull,rsiDivBear,
    context15m,
    signals,
    timeframe:'5m',
    analyzedAt:new Date().toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════
// SPOT — Weinstein + EMA + RSI + Fibonacci + Proyección realista
// ═══════════════════════════════════════════════════════════

async function analyzeSpot(sym) {
  const isCrypto=CRYPTO_SET.has(sym);
  const bars=isCrypto
    ? await fetchCGHistory(CGIDS[sym]||sym.toLowerCase())
    : await fetchYahooHistory(sym);

  if(!bars||bars.length<60){
    return{error:`Datos insuficientes para "${sym}". Si es cripto verificá el ticker. Si es acción usá el símbolo NYSE/NASDAQ.`,ticker:sym};
  }

  const closes=bars.map(b=>b.close);
  const highs=bars.map(b=>b.high||b.close);
  const lows=bars.map(b=>b.low||b.close);
  const volumes=bars.map(b=>b.volume||0);
  const n=closes.length;
  const cur=closes[n-1];

  // Indicadores
  const ema20arr=ema(closes,20);
  const ema50arr=ema(closes,50);
  const ema200arr=ema(closes,Math.min(200,n-1));
  const rsi14arr=rsi(closes,14);
  const vol20arr=sma(volumes,20);
  const atr14arr=atr(highs,lows,closes,14);

  const e20=ema20arr[n-1], e50=ema50arr[n-1], e200=ema200arr[n-1];
  const rsiCur=rsi14arr[n-1], rsiPrev=rsi14arr[n-2];
  const volCur=volumes[n-1], volAvg=vol20arr[n-1];
  const volRatio=volAvg>0?volCur/volAvg:1;
  const atrCur=atr14arr[n-1]||(cur*0.02);

  // 52w range
  const w=Math.min(252,n);
  const high52w=Math.max(...highs.slice(n-w));
  const low52w=Math.min(...lows.slice(n-w));
  const distFromHigh=((cur-high52w)/high52w)*100;
  const distFromLow=((cur-low52w)/low52w)*100;

  // Fibonacci
  const fib=fibonacci(high52w,low52w);

  // Stage Weinstein — usa MA30 (media de 30 días) como referencia original
  const ma30arr=sma(closes,30);
  const ma30=ma30arr[n-1];
  const ma30Prev=ma30arr[n-8]||ma30;
  let stage=1,stageName='Base (Stage 1)';
  const ma30Rising=ma30>ma30Prev*1.001;
  const ma30Falling=ma30<ma30Prev*0.999;
  if(cur>ma30&&ma30Rising){stage=2;stageName='Avance (Stage 2) ✅';}
  else if(cur>ma30&&!ma30Rising&&!ma30Falling){stage=3;stageName='Distribución (Stage 3) ⚠️';}
  else if(cur<ma30&&(ma30Falling||!ma30Rising)){stage=4;stageName='Declive (Stage 4) 🔴';}

  // Proyección realista
  const projShort=realisticProjection(closes.slice(-30),[7,14,21]);
  const projMedium=realisticProjection(closes.slice(-90),[30,60,90]);
  const projLong=realisticProjection(closes.slice(-180),[90,180,365]);

  // Soporte/resistencia
  const supLevels=findLevels(lows,n,60,'support').filter(l=>l.price<cur).slice(0,3);
  const resLevels=findLevels(highs,n,60,'resistance').filter(l=>l.price>cur).slice(0,3);

  // ── SEÑALES con pesos diferenciados ──
  const signals=[];
  let bullPts=0, bearPts=0;

  // Peso 3: Weinstein Stage (señal primaria)
  if(stage===2){signals.push({icon:'🟢',text:`Stage 2 (Weinstein): MA30 subiendo con precio arriba — zona de compra óptima según Weinstein`,bull:true});bullPts+=3;}
  else if(stage===4){signals.push({icon:'🔴',text:`Stage 4 (Weinstein): MA30 bajando con precio abajo — evitar o vender`,bull:false});bearPts+=3;}
  else if(stage===1){signals.push({icon:'⏳',text:`Stage 1 (Weinstein): base/acumulación — esperar ruptura con volumen para confirmar Stage 2`,bull:null});}
  else if(stage===3){signals.push({icon:'⚠️',text:`Stage 3 (Weinstein): distribución — MA30 aplanando, reducir exposición`,bull:false});bearPts+=2;}

  // Peso 2: Alineación de EMAs
  if(e20&&e50&&e200){
    if(cur>e20&&e20>e50&&e50>e200){signals.push({icon:'📈',text:`Alineación alcista perfecta: precio > EMA20 > EMA50 > EMA200`,bull:true});bullPts+=2;}
    else if(cur<e20&&e20<e50&&e50<e200){signals.push({icon:'📉',text:`Alineación bajista perfecta: precio < EMA20 < EMA50 < EMA200`,bull:false});bearPts+=2;}
    else if(cur>e50&&e50>e200){signals.push({icon:'🔼',text:`Precio sobre EMA50 y EMA200 — sesgo alcista intermedio`,bull:true});bullPts+=1;}
    else if(cur<e50&&e200&&cur<e200){signals.push({icon:'🔽',text:`Precio bajo EMA50 y EMA200 — sesgo bajista`,bull:false});bearPts+=1;}
    else{signals.push({icon:'↔️',text:`EMAs mixtas — tendencia no clara, esperar definición`,bull:null});}
  }

  // Peso 2: RSI con contexto
  if(rsiCur!=null){
    if(rsiCur<30&&rsiCur>rsiPrev){signals.push({icon:'⚡',text:`RSI ${rsiCur.toFixed(1)} — sobreventa con recuperación. Posible reversión alcista`,bull:true});bullPts+=2;}
    else if(rsiCur>70&&rsiCur<rsiPrev){signals.push({icon:'⚠️',text:`RSI ${rsiCur.toFixed(1)} — sobrecompra con debilitamiento. Posible corrección`,bull:false});bearPts+=2;}
    else if(rsiCur<30){signals.push({icon:'⚡',text:`RSI ${rsiCur.toFixed(1)} — sobreventa extrema (potencial rebote técnico)`,bull:true});bullPts+=1;}
    else if(rsiCur>70){signals.push({icon:'⚠️',text:`RSI ${rsiCur.toFixed(1)} — sobrecompra (precaución)`,bull:false});bearPts+=1;}
    else if(rsiCur>55&&rsiCur>rsiPrev){signals.push({icon:'✅',text:`RSI ${rsiCur.toFixed(1)} — momentum alcista creciente`,bull:true});bullPts+=1;}
    else if(rsiCur<45&&rsiCur<rsiPrev){signals.push({icon:'🔴',text:`RSI ${rsiCur.toFixed(1)} — momentum bajista decreciente`,bull:false});bearPts+=1;}
    else{signals.push({icon:'➡️',text:`RSI ${rsiCur.toFixed(1)} — zona neutral`,bull:null});}
  }

  // Peso 1: Volumen
  if(volRatio>2&&cur>closes[n-2]){signals.push({icon:'🔊',text:`Volumen ${volRatio.toFixed(1)}x el promedio en vela verde — acumulación fuerte`,bull:true});bullPts+=1;}
  else if(volRatio>2&&cur<closes[n-2]){signals.push({icon:'🔊',text:`Volumen ${volRatio.toFixed(1)}x en vela roja — distribución fuerte`,bull:false});bearPts+=1;}
  else if(volRatio>1.5){signals.push({icon:'📢',text:`Volumen ${volRatio.toFixed(1)}x por encima del promedio — movimiento con convicción`,bull:cur>closes[n-2]});}

  // Peso 1: Posición en rango anual
  if(distFromHigh>-3){signals.push({icon:'🏔️',text:`A solo ${Math.abs(distFromHigh).toFixed(1)}% del máximo 52s ($${high52w.toFixed(4)}) — resistencia histórica clave`,bull:null});}
  else if(distFromLow<5){signals.push({icon:'🪃',text:`A ${distFromLow.toFixed(1)}% del mínimo 52s ($${low52w.toFixed(4)}) — soporte histórico, riesgo/recompensa favorable`,bull:true});bullPts+=1;}

  // Fibonacci cercano
  const fibLevels=[
    {l:'Ret 23.6%',v:fib.r_236},{l:'Ret 38.2%',v:fib.r_382},{l:'Ret 50%',v:fib.r_500},
    {l:'Ret 61.8%',v:fib.r_618},{l:'Ret 78.6%',v:fib.r_786},
  ];
  const nearFib=fibLevels.filter(f=>Math.abs(f.v-cur)/cur<0.018);
  if(nearFib.length){signals.push({icon:'🌀',text:`Precio en nivel Fibonacci ${nearFib[0].l} ($${nearFib[0].v.toFixed(4)}) — zona técnica de alta confluencia`,bull:null});}

  // Veredicto final
  const score=bullPts-bearPts;
  let verdict,verdictColor,verdictIcon;
  if(score>=5){verdict='Compra fuerte';verdictColor='#22c55e';verdictIcon='🟢';}
  else if(score>=2){verdict='Compra';verdictColor='#86efac';verdictIcon='🔼';}
  else if(score>=0){verdict='Neutral';verdictColor='#eab308';verdictIcon='⚖️';}
  else if(score>=-3){verdict='Venta';verdictColor='#fca5a5';verdictIcon='🔽';}
  else{verdict='Venta fuerte';verdictColor='#ef4444';verdictIcon='🔴';}

  return {
    ticker:sym,mode:'spot',
    currentPrice:cur,verdict,verdictColor,verdictIcon,score,
    stage:stageName,ma30,
    ema20:e20,ema50:e50,ema200:e200,
    rsi:rsiCur,volRatio,atr:atrCur,
    high52w,low52w,distFromHigh,distFromLow,
    fibonacci:fib,nearFibLevels:nearFib,
    supports:supLevels,resistances:resLevels,
    projections:{
      short:projShort,   // 7,14,21 días
      medium:projMedium, // 30,60,90 días
      long:projLong,     // 90,180,365 días
    },
    signals,
    analyzedAt:new Date().toISOString(),
    barsCount:n,
  };
}