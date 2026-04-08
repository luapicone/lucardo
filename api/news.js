/**
 * api/news.js — v5
 * Noticias financieras reales del día via RSS + análisis de Claude Haiku
 * Devuelve 10+ noticias con fecha, fuente e impacto
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

    const prompt = `Hoy es ${today}. Analizá estas noticias financieras REALES obtenidas en este momento:

${rawArticles.map((a,i) => `${i+1}. [${a.source}] [${a.dateStr}] ${a.title}${a.description ? ' — ' + a.description.slice(0,120) : ''}`).join('\n')}

Seleccioná las 10 más relevantes para inversores y analizá su impacto real. Respondé ÚNICAMENTE con JSON array (sin markdown):
[
  {
    "titulo": "título conciso en español (máx 90 chars)",
    "fuente": "nombre de la fuente",
    "fecha": "fecha en español (ej: hoy, ayer, 8 de abril)",
    "impacto": "positivo|negativo|mixto|neutro",
    "magnitud": 1-10,
    "mercadosAfectados": ["acciones","crypto","bonos","commodities","forex","latam"],
    "resumen": "Dos oraciones: qué ocurrió y qué impacto concreto se espera en precios.",
    "activos": ["BTC","S&P500","ORO","USD"],
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
        max_tokens: 3000,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

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

async function fetchAllNews() {
  const feeds = [
    { url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories',    source: 'MarketWatch' },
    { url: 'https://feeds.content.dowjones.io/public/rss/mw_marketpulse',   source: 'MarketWatch' },
    { url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',          source: 'CNBC' },
    { url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html',           source: 'CNBC Markets' },
    { url: 'https://feeds.reuters.com/reuters/businessNews',                  source: 'Reuters' },
    { url: 'https://cryptopanic.com/news/rss/',                               source: 'CryptoPanic' },
    { url: 'https://finance.yahoo.com/news/rssindex',                         source: 'Yahoo Finance' },
    { url: 'https://www.investing.com/rss/news_25.rss',                       source: 'Investing.com' },
    { url: 'https://www.investing.com/rss/news_301.rss',                      source: 'Investing.com Crypto' },
    { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',                 source: 'CoinDesk' },
    { url: 'https://cointelegraph.com/rss',                                   source: 'CoinTelegraph' },
    { url: 'https://seekingalpha.com/market_currents.xml',                    source: 'Seeking Alpha' },
  ];

  const results = await Promise.allSettled(feeds.map(f => fetchRSS(f.url, f.source)));

  const articles = [];
  const seenTitles = new Set();

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const a of r.value) {
      const key = a.title.toLowerCase().slice(0, 60);
      if (!seenTitles.has(key) && a.title.length > 15) {
        seenTitles.add(key);
        articles.push(a);
      }
    }
  }

  // Sort: articles with dates first (most recent first)
  articles.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return articles.slice(0, 20);
}

async function fetchRSS(url, source) {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FinTrack/1.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
      signal: ctrl.signal,
    });
    if (!r.ok) return [];
    const text = await r.text();
    const articles = [];
    const items = text.match(/<item[\s\S]*?<\/item>/g) || text.match(/<entry[\s\S]*?<\/entry>/g) || [];

    for (const item of items.slice(0, 7)) {
      const title = strip(
        item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]>/)?.[1] ||
        item.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] || ''
      ).trim();

      const description = strip(
        item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]>/)?.[1] ||
        item.match(/<description[^>]*>([\s\S]*?)<\/description>/)?.[1] ||
        item.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1] || ''
      ).trim().slice(0, 200);

      const pubDateRaw =
        item.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/)?.[1] ||
        item.match(/<published[^>]*>([\s\S]*?)<\/published>/)?.[1] ||
        item.match(/<updated[^>]*>([\s\S]*?)<\/updated>/)?.[1] || '';

      let timestamp = 0, dateStr = 'hoy';
      if (pubDateRaw) {
        const d = new Date(pubDateRaw.trim());
        if (!isNaN(d.getTime())) {
          timestamp = d.getTime();
          const now = Date.now();
          const diffH = (now - timestamp) / 3600000;
          if (diffH < 1) dateStr = 'hace menos de 1 hora';
          else if (diffH < 24) dateStr = 'hace ' + Math.floor(diffH) + 'h';
          else if (diffH < 48) dateStr = 'ayer';
          else dateStr = d.toLocaleDateString('es-AR', { day:'numeric', month:'long' });
        }
      }

      if (title && title.length > 10 && title.length < 300) {
        articles.push({ title, description, source, dateStr, timestamp });
      }
    }
    return articles;
  } catch { return []; }
}

function strip(s) {
  return (s||'').replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').replace(/\s+/g,' ');
}