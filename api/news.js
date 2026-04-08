/**
 * api/news.js — v3
 * Genera análisis de noticias financieras usando Claude.
 * Configurado para respetar el límite de 10s de Vercel Hobby.
 */

// Necesario para Vercel: aumentar el timeout máximo
export const config = { maxDuration: 30 };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada.', news: [] });

  try {
    const today = new Date().toLocaleDateString('es-AR', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    const prompt = `Hoy es ${today}. Sos un analista financiero experto. Generá exactamente 6 análisis de las noticias financieras más relevantes e impactantes de este período para inversores.

Incluí noticias reales sobre: política monetaria Fed/bancos centrales, mercados de acciones (S&P500, Nasdaq), criptomonedas (Bitcoin, Ethereum), geopolítica que afecte mercados, datos macro (inflación, empleo, PIB), resultados corporativos importantes, regulaciones, economía argentina/latinoamericana.

Respondé ÚNICAMENTE con un JSON array válido (sin markdown, sin texto antes ni después):
[
  {
    "titulo": "título en español máx 85 chars",
    "fuente": "Reuters|Bloomberg|Fed|CNBC|WSJ|FMI|etc",
    "impacto": "positivo|negativo|mixto|neutro",
    "magnitud": 7,
    "mercadosAfectados": ["acciones","crypto","bonos","commodities","forex","latam"],
    "resumen": "Dos oraciones: qué ocurrió y qué impacto se espera en precios.",
    "activos": ["BTC","S&P500","ORO","USD"],
    "horizonte": "inmediato|corto|mediano"
  }
]`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', // más rápido para evitar timeout
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const err = await response.text();
      return res.status(200).json({ error: `Claude error: ${response.status}`, news: [], raw: err.slice(0,200) });
    }

    const data = await response.json();
    const raw = (data.content?.[0]?.text || '[]').trim();

    // Extraer JSON limpiando posible markdown
    const jsonStr = raw.replace(/^```json\s*/,'').replace(/\s*```$/,'').replace(/^```\s*/,'').trim();

    let news;
    try {
      news = JSON.parse(jsonStr);
      if (!Array.isArray(news)) news = [];
    } catch(e) {
      return res.status(200).json({ error: 'Parse error: ' + e.message, raw: raw.slice(0, 300), news: [] });
    }

    return res.status(200).json({
      news,
      fetchedAt: new Date().toISOString(),
    });

  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Timeout — intentá de nuevo' : String(err);
    return res.status(200).json({ error: msg, news: [] });
  }
};