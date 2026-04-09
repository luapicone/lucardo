/**
 * api/news.js — v6
 * Noticias SOLO de cripto y bolsa/acciones
 * 15+ fuentes RSS especializadas, ordenadas por fecha, analizadas por Claude
 */

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada.', news: [] });

  try {
    const rawArticles = await fetchAllNews();
    const today = new Date().toLocaleDateString('es-AR', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

    const prompt = `Hoy es ${today}. Analizá estas noticias REALES obtenidas ahora mismo de fuentes especializadas en cripto y bolsa:

${rawArticles.map((a,i) => `${i+1}. [${a.source}] [${a.dateStr}] ${a.title}${a.description ? ' — ' + a.description.slice(0,120) : ''}`).join('\n')}

Seleccioná las 12 más relevantes para inversores en cripto y acciones. Descartá cualquier noticia que NO sea de criptomonedas o mercado de acciones/bolsa.

Para cada noticia analizá:
- Impacto concreto en precios (positivo/negativo/mixto)
- Qué activos específicos afecta
- Qué esperar en los próximos días

Respondé ÚNICAMENTE con JSON array válido (sin markdown):
[
  {
    "titulo": "título conciso en español (máx 90 chars)",
    "fuente": "nombre real de la fuente",
    "fecha": "cuándo (ej: hace 2h, hoy, ayer, 9 de abril)",
    "categoria": "crypto" | "acciones",
    "impacto": "positivo|negativo|mixto|neutro",
    "magnitud": 1-10,
    "mercadosAfectados": ["acciones","crypto"],
    "resumen": "Dos oraciones: qué pasó y qué impacto esperás en precios específicamente.",
    "activos": ["BTC","ETH","AAPL","S&P500"],
    "horizonte": "inmediato|corto|mediano"
  }
]`;

    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 25000);

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ctrl.signal,
    });

    if (!resp.ok) {
      const err = await resp.text();
      return res.status(200).json({ error: 'Claude error ' + resp.status, news: [], raw: err.slice(0,200) });
    }

    const data = await resp.json();
    const raw = (data.content?.[0]?.text || '[]').replace(/```json|```/g,'').trim();

    let news;
    try { news = JSON.parse(raw); if (!Array.isArray(news)) news = []; }
    catch(e) { return res.status(200).json({ error: 'Parse error: '+e.message, raw: raw.slice(0,300), news: [] }); }

    return res.status(200).json({
      news,
      fetchedAt: new Date().toISOString(),
      sourceCount: rawArticles.length,
    });

  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Timeout — intentá de nuevo' : String(err);
    return res.status(200).json({ error: msg, news: [] });
  }
};

// Fuentes especializadas en CRIPTO y BOLSA únicamente
async function fetchAllNews() {
  const feeds = [
    // ── CRYPTO ──
    { url: 'https://cointelegraph.com/rss',                                   source: 'CoinTelegraph',   cat: 'crypto' },
    { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',                 source: 'CoinDesk',        cat: 'crypto' },
    { url: 'https://cryptopanic.com/news/rss/',                               source: 'CryptoPanic',     cat: 'crypto' },
    { url: 'https://decrypt.co/feed',                                         source: 'Decrypt',         cat: 'crypto' },
    { url: 'https://bitcoinmagazine.com/.rss/full/',                          source: 'Bitcoin Magazine', cat: 'crypto' },
    { url: 'https://thedefiant.io/feed',                                      source: 'The Defiant',     cat: 'crypto' },
    { url: 'https://cryptobriefing.com/feed/',                                source: 'Crypto Briefing', cat: 'crypto' },
    // ── BOLSA / ACCIONES ──
    { url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories',     source: 'MarketWatch',     cat: 'acciones' },
    { url: 'https://feeds.content.dowjones.io/public/rss/mw_marketpulse',    source: 'MarketWatch',     cat: 'acciones' },
    { url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',          source: 'CNBC',            cat: 'acciones' },
    { url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html',           source: 'CNBC Markets',    cat: 'acciones' },
    { url: 'https://feeds.reuters.com/reuters/businessNews',                  source: 'Reuters Business',cat: 'acciones' },
    { url: 'https://www.investing.com/rss/news_25.rss',                       source: 'Investing.com',   cat: 'acciones' },
    { url: 'https://www.investing.com/rss/news_301.rss',                      source: 'Investing Crypto',cat: 'crypto' },
    { url: 'https://finance.yahoo.com/news/rssindex',                         source: 'Yahoo Finance',   cat: 'acciones' },
    { url: 'https://seekingalpha.com/market_currents.xml',                    source: 'Seeking Alpha',   cat: 'acciones' },
    { url: 'https://www.zerohedge.com/fullrss2.xml',                          source: 'ZeroHedge',       cat: 'acciones' },
  ];

  const results = await Promise.allSettled(feeds.map(f => fetchRSS(f.url, f.source, f.cat)));
  const articles = [];
  const seen = new Set();

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const a of r.value) {
      const key = a.title.toLowerCase().slice(0, 60);
      if (!seen.has(key) && a.title.length > 15) {
        seen.add(key);
        articles.push(a);
      }
    }
  }

  // Sort by most recent first
  articles.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return articles.slice(0, 25);
}

async function fetchRSS(url, source, cat) {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FinTrack/1.0)', 'Accept': 'application/rss+xml, application/xml, text/xml, */*' },
      signal: ctrl.signal,
    });
    if (!r.ok) return [];
    const text = await r.text();
    const items = text.match(/<item[\s\S]*?<\/item>/g) || text.match(/<entry[\s\S]*?<\/entry>/g) || [];
    const articles = [];

    for (const item of items.slice(0, 6)) {
      const title = strip(
        item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]>/)?.[1] ||
        item.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] || ''
      ).trim();

      const description = strip(
        item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]>/)?.[1] ||
        item.match(/<description[^>]*>([\s\S]*?)<\/description>/)?.[1] ||
        item.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1] || ''
      ).trim().slice(0, 200);

      const pubRaw = item.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/)?.[1] ||
                     item.match(/<published[^>]*>([\s\S]*?)<\/published>/)?.[1] ||
                     item.match(/<updated[^>]*>([\s\S]*?)<\/updated>/)?.[1] || '';

      let timestamp = 0, dateStr = 'hoy';
      if (pubRaw) {
        const d = new Date(pubRaw.trim());
        if (!isNaN(d.getTime())) {
          timestamp = d.getTime();
          const diffH = (Date.now() - timestamp) / 3600000;
          if (diffH < 1)        dateStr = 'hace menos de 1 hora';
          else if (diffH < 2)   dateStr = 'hace 1 hora';
          else if (diffH < 24)  dateStr = 'hace ' + Math.floor(diffH) + 'h';
          else if (diffH < 48)  dateStr = 'ayer';
          else                  dateStr = d.toLocaleDateString('es-AR', { day:'numeric', month:'long' });
        }
      }

      if (title && title.length > 10 && title.length < 300) {
        articles.push({ title, description, source, cat, dateStr, timestamp });
      }
    }
    return articles;
  } catch { return []; }
}

function strip(s) {
  return (s||'').replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').replace(/\s+/g,' ');
}