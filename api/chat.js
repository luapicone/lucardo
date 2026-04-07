module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── PRICE ENDPOINT ──
  if (req.body && req.body.__action === 'get_price') {
    const { ticker, type } = req.body;
    const sym = (ticker || '').toUpperCase();
    const finnhubKey = process.env.FINNHUB_API_KEY;

    // Criptos via CoinGecko (sin key)
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
      XMR:'monero',XTZ:'tezos',LUNA:'terra-luna-2',LUNC:'terra-luna',
      SNX:'synthetix-network-token',CRV:'curve-dao-token',SUSHI:'sushi',
      YFI:'yearn-finance',COMP:'compound-governance-token',BAT:'basic-attention-token',
      ONE:'harmony',ZIL:'zilliqa',ENJ:'enjincoin',CHZ:'chiliz',BTT:'bittorrent',
      OCEAN:'ocean-protocol',ANKR:'ankr',STORJ:'storj',DCR:'decred',RVN:'ravencoin',
    };
    const CRYPTO_SET = new Set(Object.keys(CGIDS));
    const isCrypto = type === 'cripto' || CRYPTO_SET.has(sym);

    if (isCrypto) {
      const id = CGIDS[sym] || sym.toLowerCase();
      try {
        const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
        const d = await r.json();
        const price = d[id]?.usd ?? null;
        return res.status(200).json({ price, source: 'coingecko' });
      } catch {
        return res.status(200).json({ price: null });
      }
    }

    // Acciones/ETFs via Finnhub (con key de env)
    if (finnhubKey) {
      try {
        const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${finnhubKey}`);
        const d = await r.json();
        // Finnhub devuelve c = current price, 0 si no encuentra
        if (d.c && d.c > 0) return res.status(200).json({ price: d.c, source: 'finnhub' });
      } catch {}
    }

    // Fallback: Yahoo Finance server-side (sin CORS en el servidor)
    for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
      try {
        const r = await fetch(`${base}/v8/finance/chart/${sym}?interval=1d&range=1d`);
        if (!r.ok) continue;
        const d = await r.json();
        const price = d?.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (price) return res.status(200).json({ price, source: 'yahoo' });
      } catch { continue; }
    }

    return res.status(200).json({ price: null });
  }

  // ── ANTHROPIC PROXY ──
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada.' });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    return res.status(response.ok ? 200 : response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
};