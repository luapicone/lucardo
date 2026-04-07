/**
 * api/db.js
 * Base de datos usando Upstash Redis (gratuito).
 * Variables de entorno necesarias en Vercel:
 *   UPSTASH_REDIS_REST_URL  → de console.upstash.com
 *   UPSTASH_REDIS_REST_TOKEN → de console.upstash.com
 */

const USER_KEY = 'fintrack:main';

async function redisGet(key) {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/get/${key}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
  });
  const data = await res.json();
  if (!data.result) return null;
  return JSON.parse(data.result);
}

async function redisSet(key, value) {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/set/${key}`;
  await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(JSON.stringify(value))
  });
}

function emptyState() {
  return { operations: [], expenses: [], incomes: [], monthHistory: [], updatedAt: Date.now() };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const redisUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!redisUrl || !redisToken) {
    return res.status(500).json({
      error: 'UPSTASH no configurado. Agregá UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN en Vercel → Settings → Environment Variables.'
    });
  }

  try {
    if (req.method === 'GET') {
      let state = await redisGet(USER_KEY);
      if (!state) state = emptyState();
      return res.status(200).json(state);
    }

    if (req.method === 'POST') {
      const { action, data } = req.body;
      let state = await redisGet(USER_KEY);
      if (!state) state = emptyState();

      if (action === 'save') {
        const newState = {
          operations:   data.operations   ?? state.operations,
          expenses:     data.expenses     ?? state.expenses,
          incomes:      data.incomes      ?? state.incomes,
          monthHistory: data.monthHistory ?? state.monthHistory,
          updatedAt: Date.now()
        };
        await redisSet(USER_KEY, newState);
        return res.status(200).json({ ok: true });
      }

      if (action === 'close_month') {
        const now = new Date();
        const label = now.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
        const totalIncome  = state.incomes.reduce((s, i) => s + Number(i.amount), 0);
        const totalExpense = state.expenses.reduce((s, e) => s + Number(e.amount), 0);

        const closedMonth = {
          id: Date.now(),
          label,
          closedAt: now.toISOString(),
          incomes: state.incomes,
          expenses: state.expenses,
          totalIncome,
          totalExpense,
          balance: totalIncome - totalExpense
        };

        const newState = {
          operations:   state.operations,
          expenses:     [],
          incomes:      [],
          monthHistory: [closedMonth, ...(state.monthHistory || [])],
          updatedAt: Date.now()
        };

        await redisSet(USER_KEY, newState);
        return res.status(200).json({ ok: true, closedMonth, newState });
      }

      return res.status(400).json({ error: 'Acción no reconocida.' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('DB error:', err);
    return res.status(500).json({ error: String(err) });
  }
};