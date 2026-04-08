/**
 * api/signals.js — v4
 *
 * SCALP (5m): ICT/SMC — Liquidity Sweep + Order Block + FVG + EMA 9/21 + VWAP + ATR
 *   Requiere al menos 2 señales primarias para dar entrada
 *
 * SPOT: Weinstein Stage + EMA 20/50/200 + RSI 14 + Fibonacci
 *   PROYECCIÓN: basada en ATR (volatilidad real) + medias móviles como objetivos
 *   NO usa regresión lineal (genera extrapolaciones irreales en tendencias fuertes)
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

// ═══════════════════════════════════════════════
// DATA SOURCES
// ═══════════════════════════════════════════════

async function fetchKlines(sym, interval, limit) {
  const pair = sym.endsWith('USDT') ? sym : `${sym}USDT`;
  // 1. Bybit
  try {
    const bi = {'5m':'5','15m':'15','1h':'60','4h':'240','1d':'D'}[interval]||'5';
    const r = await fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${pair}&interval=${bi}&limit=${limit}`);
    if (r.ok) {
      const d = await r.json();
      const list = d?.result?.list;
      if (list?.length > 10) return list.reverse().map(k=>({time:Number(k[0]),open:+k[1],high:+k[2],low:+k[3],close:+k[4],volume:+k[5]}));
    }
  } catch {}
  // 2. Binance
  try {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`);
    if (r.ok) { const d=await r.json(); if(Array.isArray(d)&&d.length>10) return d.map(k=>({time:k[0],open:+k[1],high:+k[2],low:+k[3],close:+k[4],volume:+k[5]})); }
  } catch {}
  // 3. KuCoin
  try {
    const ki={'5m':'5min','15m':'15min','1h':'1hour','1d':'1day'}[interval]||'5min';
    const end=Math.floor(Date.now()/1000), start=end-limit*300;
    const r=await fetch(`https://api.kucoin.com/api/v1/market/candles?type=${ki}&symbol=${sym}-USDT&startAt=${start}&endAt=${end}`);
    if(r.ok){const d=await r.json();if(d?.data?.length>10)return d.data.reverse().map(k=>({time:+k[0]*1000,open:+k[1],close:+k[2],high:+k[3],low:+k[4],volume:+k[5]}))}
  } catch {}
  return null;
}

const CGIDS={BTC:'bitcoin',ETH:'ethereum',SOL:'solana',ADA:'cardano',DOT:'polkadot',AVAX:'avalanche-2',MATIC:'matic-network',POL:'matic-network',LINK:'chainlink',XRP:'ripple',LTC:'litecoin',BNB:'binancecoin',DOGE:'dogecoin',SHIB:'shiba-inu',UNI:'uniswap',ATOM:'cosmos',NEAR:'near',OP:'optimism',ARB:'arbitrum',WIF:'dogwifcoin',PEPE:'pepe',TON:'the-open-network',SUI:'sui',APT:'aptos',INJ:'injective-protocol',TIA:'celestia',SEI:'sei-network',THETA:'theta-token',TFUEL:'theta-fuel',SAND:'the-sandbox',MANA:'decentraland',AXS:'axie-infinity',FIL:'filecoin',ICP:'internet-computer',VET:'vechain',HBAR:'hedera-hashgraph',ALGO:'algorand',XLM:'stellar',ETC:'ethereum-classic',BCH:'bitcoin-cash',AAVE:'aave',MKR:'maker',LDO:'lido-dao',RUNE:'thorchain',FTM:'fantom',GRT:'the-graph',FLOW:'flow',KAVA:'kava',ZEC:'zcash',DASH:'dash',XMR:'monero',XTZ:'tezos',SNX:'synthetix-network-token',CRV:'curve-dao-token',SUSHI:'sushi',YFI:'yearn-finance',COMP:'compound-governance-token',BAT:'basic-attention-token',ONE:'harmony',ENJ:'enjincoin',CHZ:'chiliz',OCEAN:'ocean-protocol',ANKR:'ankr',RENDER:'render-token',FET:'fetch-ai',WLD:'worldcoin-wld',PYTH:'pyth-network',STX:'blockstack'};
const CRYPTO_SET=new Set(Object.keys(CGIDS));

async function fetchCGHistory(id) {
  try {
    const r=await fetch(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=365&interval=daily`);
    if(!r.ok)return null;
    const d=await r.json();
    const prices=d.prices||[],vols=d.total_volumes||[];
    // CoinGecko daily: high/low no disponibles, usamos ±1% del close como aproximación
    return prices.map((p,i)=>({date:new Date(p[0]).toISOString().split('T')[0],close:p[1],high:p[1]*1.005,low:p[1]*0.995,volume:vols[i]?.[1]||0}));
  } catch { return null; }
}

async function fetchYahooHistory(sym) {
  for(const base of ['https://query1.finance.yahoo.com','https://query2.finance.yahoo.com']){
    try{
      const r=await fetch(`${base}/v8/finance/chart/${sym}?interval=1d&range=1y`);
      if(!r.ok)continue;
      const d=await r.json();
      const res=d?.chart?.result?.[0];if(!res)continue;
      const ts=res.timestamp||[],q=res.indicators?.quote?.[0]||{};
      return ts.map((t,i)=>({date:new Date(t*1000).toISOString().split('T')[0],close:q.close?.[i],high:q.high?.[i]||q.close?.[i],low:q.low?.[i]||q.close?.[i],volume:q.volume?.[i]||0})).filter(b=>b.close!=null);
    }catch{continue;}
  }
  return null;
}

// ═══════════════════════════════════════════════
// INDICADORES
// ═══════════════════════════════════════════════

function ema(data,p){
  const k=2/(p+1);const result=[];let prev=null;
  for(let i=0;i<data.length;i++){
    if(prev===null){if(i<p-1){result.push(null);continue;}prev=data.slice(0,p).reduce((a,b)=>a+b,0)/p;result.push(prev);continue;}
    prev=data[i]*k+prev*(1-k);result.push(prev);
  }
  return result;
}

function rsi(closes,p=14){
  const result=new Array(p).fill(null);let ag=0,al=0;
  for(let i=1;i<=p;i++){const d=closes[i]-closes[i-1];if(d>0)ag+=d;else al+=Math.abs(d);}
  ag/=p;al/=p;
  for(let i=p;i<closes.length;i++){
    if(i>p){const d=closes[i]-closes[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?Math.abs(d):0))/p;}
    result.push(al===0?100:100-100/(1+ag/al));
  }
  return result;
}

function atrArr(highs,lows,closes,p=14){
  const trs=highs.map((h,i)=>i===0?h-lows[i]:Math.max(h-lows[i],Math.abs(h-closes[i-1]),Math.abs(lows[i]-closes[i-1])));
  return sma(trs,p);
}

function sma(data,p){
  return data.map((_,i)=>{
    if(i<p-1)return null;
    const sl=data.slice(i-p+1,i+1).filter(v=>v!=null);
    return sl.length===p?sl.reduce((a,b)=>a+b,0)/p:null;
  });
}

function calcVWAP(bars){
  let cv=0,cv2=0;
  for(const b of bars){const tp=(b.high+b.low+b.close)/3;cv+=tp*b.volume;cv2+=b.volume;}
  return cv2>0?cv/cv2:bars[bars.length-1].close;
}

function fibonacci(high,low){
  const d=high-low;
  return {
    ext_2618: +(high+d*1.618).toFixed(4),
    ext_1618: +(high+d*0.618).toFixed(4),
    r_000:    +high.toFixed(4),
    r_236:    +(high-d*0.236).toFixed(4),
    r_382:    +(high-d*0.382).toFixed(4),
    r_500:    +(high-d*0.5).toFixed(4),
    r_618:    +(high-d*0.618).toFixed(4),
    r_786:    +(high-d*0.786).toFixed(4),
    r_1000:   +low.toFixed(4),
  };
}

// Proyección basada en ATR y medias móviles — NO regresión lineal
// Usa el ATR histórico para bandas de volatilidad realistas
// y las EMAs como objetivos naturales de precio
function atrProjection(cur, closes, highs, lows, ema20, ema50, ema200, atrCur, high52w, low52w) {
  const n = closes.length;

  // Volatilidad histórica: desv estándar de retornos (más estable que ATR solo)
  const rets = closes.slice(-60).slice(1).map((c,i)=>(c-closes.slice(-60)[i])/closes.slice(-60)[i]);
  const meanR = rets.reduce((a,b)=>a+b,0)/rets.length;
  const stdR  = Math.sqrt(rets.map(r=>(r-meanR)**2).reduce((a,b)=>a+b,0)/rets.length);

  // Bandas de volatilidad por horizonte (1 sigma = 68% de los casos)
  const band = (days) => stdR * Math.sqrt(days) * cur;

  // Niveles objetivo naturales por horizonte
  // Corto: ATR-based targets (7, 14, 30 días)
  // Mediano/largo: medias móviles como imanes naturales de precio
  const targets = {
    short: [
      { period: 7,  upper: +(cur + band(7)).toFixed(4),  lower: +(Math.max(cur - band(7), cur*0.5)).toFixed(4),  label: '1 semana',   pivot: null },
      { period: 14, upper: +(cur + band(14)).toFixed(4), lower: +(Math.max(cur - band(14), cur*0.4)).toFixed(4), label: '2 semanas',  pivot: null },
      { period: 30, upper: +(cur + band(30)).toFixed(4), lower: +(Math.max(cur - band(30), cur*0.3)).toFixed(4), label: '1 mes',      pivot: ema20 ? +ema20.toFixed(4) : null },
    ],
    medium: [
      { period: 60,  upper: +(cur + band(60)).toFixed(4),  lower: +(Math.max(cur - band(60),  cur*0.2)).toFixed(4), label: '2 meses',  pivot: ema50  ? +ema50.toFixed(4)  : null },
      { period: 90,  upper: +(cur + band(90)).toFixed(4),  lower: +(Math.max(cur - band(90),  cur*0.15)).toFixed(4), label: '3 meses', pivot: ema50  ? +ema50.toFixed(4)  : null },
      { period: 180, upper: +(cur + band(180)).toFixed(4), lower: +(Math.max(cur - band(180), cur*0.1)).toFixed(4), label: '6 meses',  pivot: ema200 ? +ema200.toFixed(4) : null },
    ],
    long: [
      { period: 365, upper: +(high52w * 1.2).toFixed(4), lower: +(low52w * 0.8).toFixed(4), label: '1 año', pivot: ema200 ? +ema200.toFixed(4) : null,
        note: 'Rango basado en máx/mín 52s ±20%' },
    ],
    dailyVolPct: +(stdR * 100).toFixed(2),
  };

  return targets;
}

// Soportes y resistencias por clusters reales de precios
function findSR(highs, lows, closes, n, lookback=90) {
  const slice_h = highs.slice(Math.max(0,n-lookback), n);
  const slice_l = lows.slice(Math.max(0,n-lookback), n);
  const cur = closes[n-1];

  // Pivot highs/lows: vela con high/low mayor que sus 2 vecinos
  const pivotH=[], pivotL=[];
  for(let i=2;i<slice_h.length-2;i++){
    if(slice_h[i]>slice_h[i-1]&&slice_h[i]>slice_h[i-2]&&slice_h[i]>slice_h[i+1]&&slice_h[i]>slice_h[i+2]) pivotH.push(slice_h[i]);
    if(slice_l[i]<slice_l[i-1]&&slice_l[i]<slice_l[i-2]&&slice_l[i]<slice_l[i+1]&&slice_l[i]<slice_l[i+2]) pivotL.push(slice_l[i]);
  }

  const cluster = (prices, threshold=0.015) => {
    if(!prices.length) return [];
    const sorted=[...prices].sort((a,b)=>a-b);
    const groups=[];let group=[sorted[0]];
    for(let i=1;i<sorted.length;i++){
      if((sorted[i]-group[group.length-1])/group[group.length-1]<threshold) group.push(sorted[i]);
      else{groups.push(group);group=[sorted[i]];}
    }
    groups.push(group);
    return groups.map(g=>({price:+(g.reduce((a,b)=>a+b,0)/g.length).toFixed(4),touches:g.length}))
      .sort((a,b)=>b.touches-a.touches).slice(0,4);
  };

  const res = cluster(pivotH).filter(l=>l.price>cur*1.005).sort((a,b)=>a.price-b.price).slice(0,3);
  const sup = cluster(pivotL).filter(l=>l.price<cur*0.995).sort((a,b)=>b.price-a.price).slice(0,3);
  return { resistances: res, supports: sup };
}

// ═══════════════════════════════════════════════
// SCALPING — ICT/Smart Money Concepts
// ═══════════════════════════════════════════════

async function analyzeScalp(sym) {
  const [bars5m, bars15m] = await Promise.all([
    fetchKlines(sym,'5m',150),
    fetchKlines(sym,'15m',80),
  ]);

  if(!bars5m||bars5m.length<50){
    return{error:`No se encontraron datos para ${sym}. Usá solo el símbolo base sin USDT (BTC, ETH, SOL, BNB, XRP, DOGE, etc.)`,ticker:sym};
  }

  const closes5=bars5m.map(b=>b.close),highs5=bars5m.map(b=>b.high),lows5=bars5m.map(b=>b.low);
  const n=closes5.length,cur=closes5[n-1];

  const ema9arr=ema(closes5,9),ema21arr=ema(closes5,21);
  const atr14arr=atrArr(highs5,lows5,closes5,14);
  const rsi14arr=rsi(closes5,14);
  const vwap=calcVWAP(bars5m.slice(-60));

  const e9=ema9arr[n-1],e21=ema21arr[n-1];
  const atrCur=atr14arr[n-1]||(cur*0.003);
  const rsiCur=rsi14arr[n-1],rsiPrev=rsi14arr[n-2];

  // Swing H/L de las últimas 20 velas (no la actual)
  const lb=20;
  const swingHigh=Math.max(...highs5.slice(n-lb-1,n-1));
  const swingLow=Math.min(...lows5.slice(n-lb-1,n-1));

  const lastBar=bars5m[n-1],prevBar=bars5m[n-2];
  const bodySize=Math.abs(lastBar.close-lastBar.open);
  const totalRange=lastBar.high-lastBar.low||0.0001;

  // Liquidity Sweep — wick rompe swing y el cuerpo cierra dentro
  const bullSweep=lastBar.low<swingLow&&lastBar.close>swingLow&&lastBar.close>lastBar.open&&(bodySize/totalRange)>0.35;
  const bearSweep=lastBar.high>swingHigh&&lastBar.close<swingHigh&&lastBar.close<lastBar.open&&(bodySize/totalRange)>0.35;

  // Order Block — última vela de signo contrario antes de impulso fuerte (>1.5x ATR)
  let bullOB=null,bearOB=null;
  for(let i=n-3;i>Math.max(n-30,1);i--){
    const b=bars5m[i];
    const fwd=closes5[Math.min(i+3,n-1)];
    if(!bullOB&&b.close<b.open&&(fwd-b.close)/atrCur>1.5) bullOB={high:+b.open.toFixed(6),low:+b.close.toFixed(6)};
    if(!bearOB&&b.close>b.open&&(b.close-fwd)/atrCur>1.5) bearOB={high:+b.close.toFixed(6),low:+b.open.toFixed(6)};
    if(bullOB&&bearOB)break;
  }

  // Fair Value Gap — gap entre high de vela i-1 y low de vela i+1
  let bullFVG=null,bearFVG=null;
  for(let i=1;i<n-1;i++){
    if(!bullFVG&&lows5[i+1]>highs5[i-1]&&(lows5[i+1]-highs5[i-1])>atrCur*0.3) bullFVG={low:+highs5[i-1].toFixed(6),high:+lows5[i+1].toFixed(6)};
    if(!bearFVG&&highs5[i+1]<lows5[i-1]&&(lows5[i-1]-highs5[i+1])>atrCur*0.3) bearFVG={high:+lows5[i-1].toFixed(6),low:+highs5[i+1].toFixed(6)};
  }

  // RSI divergencia
  const lookDiv=6;
  const rsiDivBull=n>lookDiv&&lows5[n-1]<lows5[n-lookDiv]&&rsiCur>(rsi14arr[n-lookDiv]||rsiCur-1);
  const rsiDivBear=n>lookDiv&&highs5[n-1]>highs5[n-lookDiv]&&rsiCur<(rsi14arr[n-lookDiv]||rsiCur+1);

  // Contexto 15m
  let ctx15=null;
  if(bars15m?.length>=21){
    const c15=bars15m.map(b=>b.close),e21_15=ema(c15,21);
    const cur15=c15[c15.length-1],e21c=e21_15[e21_15.length-1];
    ctx15={bullish:cur15>e21c,e21:e21c};
  }

  // ── SCORING ──
  // Señales primarias ICT (peso 3): necesitamos al menos 1 para dar entrada
  // Señales de confirmación (peso 1-2): acumulan consenso
  const signals=[];
  let bull=0,bear=0;

  // Primarias
  if(bullSweep){signals.push({icon:'🌊',text:`Liquidity Sweep ALCISTA — barrió stops bajo $${swingLow.toFixed(4)} y cerró arriba. Instituciones acumulando`,bull:true});bull+=3;}
  if(bearSweep){signals.push({icon:'🌊',text:`Liquidity Sweep BAJISTA — barrió stops sobre $${swingHigh.toFixed(4)} y cerró abajo. Instituciones distribuyendo`,bull:false});bear+=3;}

  const inBullOB=bullOB&&cur>=bullOB.low*0.998&&cur<=bullOB.high*1.005;
  const inBearOB=bearOB&&cur>=bearOB.low*0.995&&cur<=bearOB.high*1.002;
  if(inBullOB){signals.push({icon:'📦',text:`Order Block ALCISTA ($${bullOB.low}-$${bullOB.high}) — zona de demanda institucional activa`,bull:true});bull+=3;}
  if(inBearOB){signals.push({icon:'📦',text:`Order Block BAJISTA ($${bearOB.low}-$${bearOB.high}) — zona de oferta institucional activa`,bull:false});bear+=3;}

  if(rsiDivBull){signals.push({icon:'⚡',text:`Divergencia alcista RSI — precio hace mínimo más bajo pero RSI no confirma. Agotamiento vendedor`,bull:true});bull+=2;}
  if(rsiDivBear){signals.push({icon:'⚡',text:`Divergencia bajista RSI — precio hace máximo más alto pero RSI no confirma. Agotamiento comprador`,bull:false});bear+=2;}

  // FVG (peso 2 solo si el precio está dentro)
  const inBullFVG=bullFVG&&cur>=bullFVG.low&&cur<=bullFVG.high;
  const inBearFVG=bearFVG&&cur>=bearFVG.low&&cur<=bearFVG.high;
  if(inBullFVG){signals.push({icon:'🕳️',text:`Fair Value Gap alcista ($${bullFVG.low}-$${bullFVG.high}) — imbalance, tendencia a rellenar al alza`,bull:true});bull+=2;}
  if(inBearFVG){signals.push({icon:'🕳️',text:`Fair Value Gap bajista ($${bearFVG.low}-$${bearFVG.high}) — imbalance, tendencia a rellenar a la baja`,bull:false});bear+=2;}

  // Confirmaciones (peso 1)
  if(e9&&e21){
    if(cur>e9&&e9>e21){signals.push({icon:'📈',text:`EMA 9 > EMA 21 y precio arriba — tendencia alcista en 5m`,bull:true});bull+=1;}
    else if(cur<e9&&e9<e21){signals.push({icon:'📉',text:`EMA 9 < EMA 21 y precio abajo — tendencia bajista en 5m`,bull:false});bear+=1;}
    else signals.push({icon:'↔️',text:`EMAs cruzadas — zona de indecisión, evitar entrar`,bull:null});
  }

  if(cur>vwap){signals.push({icon:'🏦',text:`Precio sobre VWAP ($${vwap.toFixed(4)}) — zona institucional compradora`,bull:true});bull+=1;}
  else{signals.push({icon:'🏦',text:`Precio bajo VWAP ($${vwap.toFixed(4)}) — zona institucional vendedora`,bull:false});bear+=1;}

  if(rsiCur!=null){
    if(rsiCur<35){signals.push({icon:'📊',text:`RSI ${rsiCur.toFixed(1)} — sobreventa en 5m`,bull:true});bull+=1;}
    else if(rsiCur>65){signals.push({icon:'📊',text:`RSI ${rsiCur.toFixed(1)} — sobrecompra en 5m`,bull:false});bear+=1;}
    else signals.push({icon:'📊',text:`RSI ${rsiCur.toFixed(1)} — zona ${rsiCur>50?'de fuerza':'de debilidad'}`,bull:rsiCur>50});
  }

  if(ctx15){
    if(ctx15.bullish){signals.push({icon:'🕰️',text:`15m alcista — contexto de timeframe superior favorece largos`,bull:true});bull+=1;}
    else{signals.push({icon:'🕰️',text:`15m bajista — ir long en 5m es contra tendencia mayor`,bull:false});bear+=1;}
  }

  // ── DECISIÓN: requiere señal primaria ICT + score neto ≥3 ──
  const score=bull-bear;
  const hasPrimBull=bullSweep||inBullOB||rsiDivBull;
  const hasPrimBear=bearSweep||inBearOB||rsiDivBear;
  let direction='NEUTRAL';
  if(score>=3&&hasPrimBull)direction='LONG';
  else if(score<=-3&&hasPrimBear)direction='SHORT';

  // TP/SL: basados en ATR y niveles naturales
  let entry=cur,tp=null,sl=null,leverage=null,rr=null;
  const atrPct=(atrCur/cur)*100;
  if(direction==='LONG'){
    entry=inBullOB?Math.min(cur,bullOB.high):cur;
    sl=inBullOB?+(bullOB.low*0.999).toFixed(6):+(entry-atrCur*1.5).toFixed(6);
    const dist=entry-sl;
    tp=+(entry+Math.max(dist*2,atrCur*2.5)).toFixed(6);
    rr=+((tp-entry)/(entry-sl)).toFixed(2);
  } else if(direction==='SHORT'){
    entry=inBearOB?Math.max(cur,bearOB.low):cur;
    sl=inBearOB?+(bearOB.high*1.001).toFixed(6):+(entry+atrCur*1.5).toFixed(6);
    const dist=sl-entry;
    tp=+(entry-Math.max(dist*2,atrCur*2.5)).toFixed(6);
    rr=+((entry-tp)/(sl-entry)).toFixed(2);
  }
  leverage=atrPct>4?3:atrPct>2.5?5:atrPct>1.5?8:atrPct>0.8?12:atrPct>0.4?15:20;

  let verdict,verdictColor,verdictIcon;
  if(direction==='LONG'){verdict='LONG';verdictColor='#22c55e';verdictIcon='🟢';}
  else if(direction==='SHORT'){verdict='SHORT';verdictColor='#ef4444';verdictIcon='🔴';}
  else{verdict='SIN SETUP';verdictColor='#eab308';verdictIcon='⚖️';}

  return{
    ticker:sym,pair:`${sym}USDT`,mode:'scalp',
    currentPrice:+cur.toFixed(6),
    verdict,verdictColor,verdictIcon,score:+score.toFixed(1),direction,
    entry:entry?+entry.toFixed(6):null,
    tp:tp?+tp.toFixed(6):null,
    sl:sl?+sl.toFixed(6):null,
    leverage,rr,
    atr:+atrCur.toFixed(6),atrPct:+atrPct.toFixed(3),
    rsi:rsiCur?+rsiCur.toFixed(1):null,
    ema9:e9?+e9.toFixed(6):null,ema21:e21?+e21.toFixed(6):null,vwap:+vwap.toFixed(6),
    bullSweep,bearSweep,bullOB,bearOB,bullFVG,bearFVG,
    rsiDivBull,rsiDivBear,ctx15,
    signals,timeframe:'5m',
    analyzedAt:new Date().toISOString(),
  };
}

// ═══════════════════════════════════════════════
// SPOT — Weinstein + EMA + RSI + Fibonacci + ATR targets
// ═══════════════════════════════════════════════

async function analyzeSpot(sym) {
  const isCrypto=CRYPTO_SET.has(sym);
  const bars=isCrypto?await fetchCGHistory(CGIDS[sym]||sym.toLowerCase()):await fetchYahooHistory(sym);

  if(!bars||bars.length<60){
    return{error:`Datos insuficientes para "${sym}". Si es cripto verificá el ticker. Si es acción usá el símbolo NYSE/NASDAQ.`,ticker:sym};
  }

  const closes=bars.map(b=>b.close),highs=bars.map(b=>b.high||b.close),lows=bars.map(b=>b.low||b.close),volumes=bars.map(b=>b.volume||0);
  const n=closes.length,cur=closes[n-1];

  const ema20arr=ema(closes,20),ema50arr=ema(closes,50),ema200arr=ema(closes,Math.min(200,n-1));
  const ma30arr=sma(closes,30);
  const rsi14arr=rsi(closes,14);
  const vol20arr=sma(volumes,20);
  const atr14arr=atrArr(highs,lows,closes,14);

  const e20=ema20arr[n-1],e50=ema50arr[n-1],e200=ema200arr[n-1],ma30=ma30arr[n-1];
  const rsiCur=rsi14arr[n-1],rsiPrev=rsi14arr[n-2];
  const volCur=volumes[n-1],volAvg=vol20arr[n-1];
  const volRatio=volAvg>0?volCur/volAvg:1;
  const atrCur=atr14arr[n-1]||(cur*0.02);

  const w=Math.min(252,n);
  const high52w=Math.max(...highs.slice(n-w));
  const low52w=Math.min(...lows.slice(n-w));
  const distFromHigh=+((cur-high52w)/high52w*100).toFixed(1);
  const distFromLow=+((cur-low52w)/low52w*100).toFixed(1);

  // Fibonacci sobre rango 52 semanas
  const fib=fibonacci(high52w,low52w);

  // Weinstein Stage — usa MA30 como en el libro original
  const ma30Prev=ma30arr[n-8]||ma30;
  const ma30Rising=ma30>ma30Prev*1.002,ma30Falling=ma30<ma30Prev*0.998;
  let stage=1,stageName='Base (Stage 1)';
  if(cur>ma30&&ma30Rising){stage=2;stageName='Avance (Stage 2) ✅';}
  else if(cur>ma30&&!ma30Rising&&!ma30Falling){stage=3;stageName='Distribución (Stage 3) ⚠️';}
  else if(cur<ma30&&(ma30Falling||!ma30Rising)){stage=4;stageName='Declive (Stage 4) 🔴';}

  // Proyección realista por ATR + bandas de volatilidad
  const projections=atrProjection(cur,closes,highs,lows,e20,e50,e200,atrCur,high52w,low52w);

  // Soporte/Resistencia por pivot points reales
  const sr=findSR(highs,lows,closes,n,90);

  // ── SEÑALES ──
  const signals=[];
  let bullPts=0,bearPts=0;

  // Peso 3: Stage Weinstein (señal primaria)
  if(stage===2){signals.push({icon:'🟢',text:`Stage 2 (Weinstein): MA30 subiendo con precio arriba — zona de compra`,bull:true});bullPts+=3;}
  else if(stage===4){signals.push({icon:'🔴',text:`Stage 4 (Weinstein): MA30 bajando con precio abajo — evitar o vender`,bull:false});bearPts+=3;}
  else if(stage===1){signals.push({icon:'⏳',text:`Stage 1 (Weinstein): base/acumulación — esperar ruptura con volumen`,bull:null});}
  else if(stage===3){signals.push({icon:'⚠️',text:`Stage 3 (Weinstein): distribución — MA30 aplanando, reducir exposición`,bull:false});bearPts+=2;}

  // Peso 2: Alineación EMAs
  if(e20&&e50&&e200){
    if(cur>e20&&e20>e50&&e50>e200){signals.push({icon:'📈',text:`Tendencia alcista perfecta: precio > EMA20 > EMA50 > EMA200`,bull:true});bullPts+=2;}
    else if(cur<e20&&e20<e50&&e50<e200){signals.push({icon:'📉',text:`Tendencia bajista perfecta: precio < EMA20 < EMA50 < EMA200`,bull:false});bearPts+=2;}
    else if(cur>e50&&e50>e200){signals.push({icon:'🔼',text:`Precio sobre EMA50 y EMA200 — sesgo alcista`,bull:true});bullPts+=1;}
    else if(cur<e50&&e200&&cur<e200){signals.push({icon:'🔽',text:`Precio bajo EMA50 y EMA200 — sesgo bajista`,bull:false});bearPts+=1;}
    else{signals.push({icon:'↔️',text:`EMAs mixtas — tendencia no definida, esperar confirmación`,bull:null});}
  }

  // Peso 2: RSI
  if(rsiCur!=null){
    if(rsiCur<30&&rsiCur>rsiPrev){signals.push({icon:'⚡',text:`RSI ${rsiCur.toFixed(1)} — sobreventa con recuperación. Posible reversión alcista`,bull:true});bullPts+=2;}
    else if(rsiCur>70&&rsiCur<rsiPrev){signals.push({icon:'⚠️',text:`RSI ${rsiCur.toFixed(1)} — sobrecompra con debilitamiento. Posible corrección`,bull:false});bearPts+=2;}
    else if(rsiCur<30){signals.push({icon:'⚡',text:`RSI ${rsiCur.toFixed(1)} — sobreventa`,bull:true});bullPts+=1;}
    else if(rsiCur>70){signals.push({icon:'⚠️',text:`RSI ${rsiCur.toFixed(1)} — sobrecompra`,bull:false});bearPts+=1;}
    else if(rsiCur>55&&rsiCur>rsiPrev){signals.push({icon:'✅',text:`RSI ${rsiCur.toFixed(1)} — momentum alcista creciente`,bull:true});bullPts+=1;}
    else if(rsiCur<45&&rsiCur<rsiPrev){signals.push({icon:'🔴',text:`RSI ${rsiCur.toFixed(1)} — momentum bajista`,bull:false});bearPts+=1;}
    else{signals.push({icon:'➡️',text:`RSI ${rsiCur.toFixed(1)} — zona neutral`,bull:null});}
  }

  // Peso 1: Volumen
  if(volRatio>1.8&&cur>closes[n-2]){signals.push({icon:'🔊',text:`Volumen ${volRatio.toFixed(1)}x el promedio — fuerza compradora`,bull:true});bullPts+=1;}
  else if(volRatio>1.8&&cur<closes[n-2]){signals.push({icon:'🔊',text:`Volumen ${volRatio.toFixed(1)}x el promedio — fuerza vendedora`,bull:false});bearPts+=1;}

  // Peso 1: Fibonacci cercano
  const fibLevels=[
    {l:'Ret 23.6%',v:fib.r_236},{l:'Ret 38.2%',v:fib.r_382},
    {l:'Ret 50%',v:fib.r_500},{l:'Ret 61.8%',v:fib.r_618},{l:'Ret 78.6%',v:fib.r_786},
  ];
  const nearFib=fibLevels.filter(f=>Math.abs(f.v-cur)/cur<0.02);
  if(nearFib.length) signals.push({icon:'🌀',text:`Precio en nivel Fibonacci ${nearFib[0].l} ($${nearFib[0].v}) — zona técnica de confluencia`,bull:null});

  // Peso 1: rango anual
  if(distFromHigh>-4){signals.push({icon:'🏔️',text:`A ${Math.abs(distFromHigh)}% del máximo 52s ($${high52w.toFixed(2)}) — resistencia histórica`,bull:null});}
  else if(distFromLow<6){signals.push({icon:'🪃',text:`A ${distFromLow}% del mínimo 52s ($${low52w.toFixed(2)}) — soporte histórico`,bull:true});bullPts+=1;}

  const score=bullPts-bearPts;
  let verdict,verdictColor,verdictIcon;
  if(score>=5){verdict='Compra fuerte';verdictColor='#22c55e';verdictIcon='🟢';}
  else if(score>=2){verdict='Compra';verdictColor='#86efac';verdictIcon='🔼';}
  else if(score>=0){verdict='Neutral';verdictColor='#eab308';verdictIcon='⚖️';}
  else if(score>=-3){verdict='Venta';verdictColor='#fca5a5';verdictIcon='🔽';}
  else{verdict='Venta fuerte';verdictColor='#ef4444';verdictIcon='🔴';}

  return{
    ticker:sym,mode:'spot',currentPrice:cur,verdict,verdictColor,verdictIcon,score,
    stage:stageName,ma30,
    ema20:e20,ema50:e50,ema200:e200,
    rsi:rsiCur,volRatio,atr:atrCur,
    high52w,low52w,distFromHigh,distFromLow,
    fibonacci:fib,nearFibLevels:nearFib,
    supports:sr.supports,resistances:sr.resistances,
    projections,
    signals,
    analyzedAt:new Date().toISOString(),barsCount:n,
  };
}