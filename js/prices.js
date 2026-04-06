/**
 * prices.js
 * Obtiene precios en tiempo real desde Yahoo Finance (acciones/ETFs)
 * y CoinGecko (criptomonedas). Sin API keys requeridas.
 */

/* Cache de precios: { TICKER: price } */
const priceCache = {};

/* Mapa de tickers cripto → IDs de CoinGecko */
const COINGECKO_IDS = {
  BTC:   'bitcoin',
  ETH:   'ethereum',
  SOL:   'solana',
  ADA:   'cardano',
  DOT:   'polkadot',
  AVAX:  'avalanche-2',
  MATIC: 'matic-network',
  POL:   'matic-network',
  LINK:  'chainlink',
  XRP:   'ripple',
  LTC:   'litecoin',
  BNB:   'binancecoin',
  DOGE:  'dogecoin',
  SHIB:  'shiba-inu',
  UNI:   'uniswap',
  ATOM:  'cosmos',
  NEAR:  'near',
  OP:    'optimism',
  ARB:   'arbitrum',
  WIF:   'dogwifcoin',
  PEPE:  'pepe',
  USDT:  'tether',
  USDC:  'usd-coin',
  TON:   'the-open-network',
  SUI:   'sui',
  APT:   'aptos',
  INJ:   'injective-protocol',
  TIA:   'celestia',
  SEI:   'sei-network',
};

/* Set de tickers reconocidos como cripto */
const CRYPTO_SET = new Set(Object.keys(COINGECKO_IDS));

/**
 * Determina si un ticker es cripto o no.
 */
function isCrypto(ticker, type) {
  return type === 'cripto' || CRYPTO_SET.has(ticker.toUpperCase());
}

/**
 * Obtiene el precio actual de una cripto desde CoinGecko.
 * @param {string} ticker - símbolo (ej: BTC)
 * @returns {number|null} precio en USD o null si falló
 */
async function fetchCryptoPrice(ticker) {
  const sym = ticker.toUpperCase();
  const id = COINGECKO_IDS[sym] || sym.toLowerCase();
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data[id]?.usd ?? null;
  } catch {
    return null;
  }
}

/**
 * Obtiene el precio actual de una acción o ETF desde Yahoo Finance.
 * Intenta con dos endpoints por si uno falla.
 * @param {string} ticker - símbolo (ej: AAPL, SPY, MELI)
 * @returns {number|null} precio en USD o null si falló
 */
async function fetchStockPrice(ticker) {
  const sym = encodeURIComponent(ticker.toUpperCase());
  const endpoints = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`,
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: { 'Accept': 'application/json' },
      });
      if (!res.ok) continue;
      const data = await res.json();
      const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (price) return price;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Obtiene el precio de un activo (detecta automáticamente si es cripto o acción).
 * @param {string} ticker
 * @param {string} type - 'cripto' | 'accion' | 'etf' | etc.
 * @returns {number|null}
 */
async function fetchPrice(ticker, type) {
  if (isCrypto(ticker, type)) {
    return await fetchCryptoPrice(ticker);
  }
  return await fetchStockPrice(ticker);
}

/**
 * Refresca los precios de todas las operaciones guardadas en `db`.
 * Actualiza `priceCache` y retorna true si al menos uno tuvo éxito.
 * @returns {Promise<boolean>}
 */
async function refreshAllPrices() {
  if (!db.operations.length) return false;

  /* Deduplica por ticker+type */
  const unique = [...new Map(
    db.operations.map(o => [`${o.ticker}:${o.type}`, o])
  ).values()];

  const results = await Promise.allSettled(
    unique.map(async ({ ticker, type }) => {
      const price = await fetchPrice(ticker, type);
      if (price !== null) priceCache[ticker.toUpperCase()] = price;
      return { ticker, price };
    })
  );

  const now = new Date().toLocaleTimeString('es-AR', {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });

  const el = document.getElementById('last-update');
  if (el) el.textContent = `Actualizado ${now}`;

  return results.some(r => r.status === 'fulfilled' && r.value.price !== null);
}

/**
 * Devuelve el precio actual de un ticker desde el cache.
 * @param {string} ticker
 * @returns {number|null}
 */
function getCurrentPrice(ticker) {
  return priceCache[ticker.toUpperCase()] ?? null;
}

/**
 * Calcula el PnL de una operación usando el precio del cache.
 * @param {object} op - operación
 * @returns {{ currentPrice, currentValue, pnl, pnlPct, hasPnl }}
 */
function calcPnl(op) {
  const invested     = op.quantity * op.buyPrice;
  const currentPrice = getCurrentPrice(op.ticker);
  const hasPnl       = currentPrice !== null;
  const currentValue = hasPnl ? op.quantity * currentPrice : invested;
  const pnl          = currentValue - invested;
  const pnlPct       = invested > 0 ? (pnl / invested) * 100 : 0;
  return { currentPrice, currentValue, pnl, pnlPct, hasPnl };
}
