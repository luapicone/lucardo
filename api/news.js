/**
 * api/news.js
 * Usa Claude para generar análisis de noticias financieras relevantes
 * del mercado actual, con su impacto estimado.
 */

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada.' });

  try {
    const today = new Date().toLocaleDateString('es-AR', { 
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
    });

    // Primero intentamos obtener noticias reales via RSS
    let realNews = [];
    try {
      const rssUrls = [
        'https://feeds.finance.yahoo.com/rss/2.0/headline?s=^GSPC,BTC-USD&region=US&lang=en-US',
        'https://www.cnbc.com/id/100003114/device/rss/rss.html',
      ];
      for (const url of rssUrls) {
        try {
          const r = await fetch(url, { 
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FinTrack/1.0)' },
            signal: AbortSignal.timeout(4000) 
          });
          if (!r.ok) continue;
          const text = await r.text();
          const items = text.match(/<item>([\s\S]*?)<\/item>/g) || [];
          for (const item of items.slice(0, 6)) {
            const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] ||
                          item.match(/<title>(.*?)<\/title>/)?.[1] || '').trim();
            if (title && title.length > 15 && title.length < 200) {
              realNews.push(title);
            }
          }
          if (realNews.length >= 5) break;
        } catch {}
      }
    } catch {}

    const newsContext = realNews.length > 0
      ? `Noticias reales obtenidas hoy:\n${realNews.map((n,i) => `${i+1}. ${n}`).join('\n')}\n\nAnalizá estas noticias reales y también agregá otras noticias relevantes que sepas del período reciente.`
      : `Hoy es ${today}. Basándote en tu conocimiento del contexto económico y financiero global más reciente, generá un análisis de las noticias más relevantes para inversores.`;

    const prompt = `${newsContext}

Generá exactamente 6 análisis de noticias financieras importantes para inversores. Deben ser noticias REALES y actuales (no inventadas), relacionadas con: mercados financieros, criptomonedas, política monetaria de la Fed/bancos centrales, geopolítica que afecte mercados, datos económicos, resultados corporativos importantes, regulaciones crypto, Argentina/Latinoamérica.

Respondé ÚNICAMENTE con este JSON array (sin markdown, sin texto extra):
[
  {
    "titulo": "título conciso en español (máx 90 caracteres)",
    "fuente": "fuente real (Reuters, Bloomberg, CNBC, Fed, etc)",
    "impacto": "positivo" | "negativo" | "mixto" | "neutro",
    "magnitud": número 1-10,
    "mercadosAfectados": ["crypto", "acciones", "bonos", "commodities", "forex", "latam"],
    "resumen": "En 2 oraciones: qué pasó y qué se espera del mercado como consecuencia",
    "activos": ["BTC", "S&P500", "ORO", "USD", "AAPL" etc — máx 4 activos específicos],
    "horizonte": "inmediato" | "corto" | "mediano"
  }
]`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(500).json({ error: err?.error?.message || 'Error llamando a Claude', news: [] });
    }

    const data = await response.json();
    const raw = (data.content?.[0]?.text || '[]').replace(/```json|```/g, '').trim();

    let news;
    try { news = JSON.parse(raw); }
    catch { 
      // Si el JSON tiene un error, devolvemos el texto crudo para debug
      return res.status(200).json({ error: 'Error parseando respuesta', raw: raw.slice(0, 500), news: [] }); 
    }

    return res.status(200).json({
      news: Array.isArray(news) ? news : [],
      fetchedAt: new Date().toISOString(),
      hadRealNews: realNews.length > 0,
    });

  } catch (err) {
    console.error('News error:', err);
    return res.status(500).json({ error: String(err), news: [] });
  }
};