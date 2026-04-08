/**
 * api/news.js — v4 REAL-TIME
 * Obtiene noticias REALES del día usando múltiples fuentes:
 * 1. MarketWatch RSS (tiempo real, sin key)
 * 2. CNBC RSS (tiempo real, sin key)  
 * 3. Cryptopanic RSS para crypto (sin key)
 * 4. Reuters RSS (sin key)
 * Luego Claude analiza las noticias reales y da el impacto.
 */

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada.', news: [] });

  try {
    // Fetch real news from multiple RSS sources in parallel
    const rawArticles = await fetchAllNews();
    
    if (!rawArticles.length) {
      return res.status(200).json({ error: 'No se pudieron obtener noticias en este momento.', news: [] });
    }

    // Ask Claude to analyze REAL articles
    const today = new Date().toLocaleDateString('es-AR', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
    const prompt = `Hoy es ${today}. Analizá estas noticias REALES obtenidas ahora mismo de fuentes financieras:

${rawArticles.map((a,i) => `${i+1}. [${a.source}] ${a.title}${a.description ? '\n   ' + a.description.slice(0,150) : ''}`).join('\n\n')}

Para cada noticia relevante para inversores, analizá su impacto real en mercados. Seleccioná las 6 más importantes.

Respondé ÚNICAMENTE con JSON array válido (sin markdown):
[
  {
    "titulo": "título en español conciso (máx 90 chars)",
    "fuente": "nombre de la fuente real",
    "impacto": "positivo|negativo|mixto|neutro",
    "magnitud": 1-10,
    "mercadosAfectados": ["acciones","crypto","bonos","commodities","forex","latam"],
    "resumen": "Dos oraciones: qué dice la noticia y qué impacto concreto esperás en precios.",
    "activos": ["ticker1","ticker2"],
    "horizonte": "inmediato|corto|mediano"
  }
]`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2500,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      const err = await resp.text();
      return res.status(200).json({ error: `Claude error ${resp.status}`, news: [], raw: err.slice(0,200) });
    }

    const data = await resp.json();
    const raw = (data.content?.[0]?.text || '[]').replace(/```json|```/g,'').trim();

    let news;
    try { news = JSON.parse(raw); if (!Array.isArray(news)) news = []; }
    catch(e) { return res.status(200).json({ error: 'Parse error: '+e.message, raw: raw.slice(0,300), news: [] }); }

    return res.status(200).json({
      news,
      fetchedAt: new Date().toISOString(),
      sources: rawArticles.length,
    });

  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Timeout — intentá de nuevo' : String(err);
    return res.status(200).json({ error: msg, news: [] });
  }
};

// ── RSS FETCH ─────────────────────────────────────────────────────────────

async function fetchAllNews() {
  const feeds = [
    // MarketWatch - mercado en general
    { url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', source: 'MarketWatch' },
    { url: 'https://feeds.content.dowjones.io/public/rss/mw_marketpulse', source: 'MarketWatch' },
    // CNBC
    { url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', source: 'CNBC' },
    { url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html', source: 'CNBC Markets' },
    // Reuters Business
    { url: 'https://feeds.reuters.com/reuters/businessNews', source: 'Reuters' },
    { url: 'https://feeds.reuters.com/reuters/UKbusinessNews', source: 'Reuters' },
    // CryptoPanic - crypto news
    { url: 'https://cryptopanic.com/news/rss/', source: 'CryptoPanic' },
    // Yahoo Finance
    { url: 'https://finance.yahoo.com/news/rssindex', source: 'Yahoo Finance' },
    // Investing.com
    { url: 'https://www.investing.com/rss/news_25.rss', source: 'Investing.com Stocks' },
    { url: 'https://www.investing.com/rss/news_301.rss', source: 'Investing.com Crypto' },
  ];

  const results = await Promise.allSettled(
    feeds.map(f => fetchRSS(f.url, f.source))
  );

  const articles = [];
  const seenTitles = new Set();

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const a of r.value) {
      // Deduplicar por título similar
      const key = a.title.toLowerCase().slice(0, 50);
      if (!seenTitles.has(key) && a.title.length > 15) {
        seenTitles.add(key);
        articles.push(a);
      }
    }
  }

  // Ordenar por más recientes y tomar top 15
  return articles.slice(0, 15);
}

async function fetchRSS(url, source) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FinTrack/1.0; +https://lucardo-cyan.vercel.app)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return [];

    const text = await r.text();
    const articles = [];

    // Parse items from RSS/Atom
    const items = text.match(/<item[\s>]([\s\S]*?)<\/item>/g) || 
                  text.match(/<entry[\s>]([\s\S]*?)<\/entry>/g) || [];

    for (const item of items.slice(0, 5)) {
      const title = stripHTML(
        item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)?.[1] ||
        item.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] || ''
      ).trim();

      const description = stripHTML(
        item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1] ||
        item.match(/<description[^>]*>([\s\S]*?)<\/description>/)?.[1] ||
        item.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1] || ''
      ).trim().slice(0, 200);

      const pubDate = item.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/)?.[1] ||
                      item.match(/<published[^>]*>([\s\S]*?)<\/published>/)?.[1] || '';

      if (title && title.length > 10 && title.length < 300) {
        articles.push({ title, description, source, pubDate });
      }
    }
    return articles;
  } catch { return []; }
}

function stripHTML(str) {
  return (str || '').replace(/<[^>]*>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').replace(/\s+/g,' ');
}