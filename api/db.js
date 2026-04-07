/**
 * api/db.js — Upstash Redis backend
 */

const USER_KEY = 'fintrack:main';

async function redisGet(key) {
  const res = await fetch(
    `${process.env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }
  );
  const data = await res.json();
  if (!data.result) return null;
  // Upstash devuelve el valor como string — parseamos una sola vez
  const val = data.result;
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return null; }
  }
  return val;
}

async function redisSet(key, value) {
  // Guardamos como string JSON simple (una sola capa)
  await fetch(
    `${process.env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      // Upstash espera el body como: ["SET", "key", "value"]
      // Pero con el REST API podemos mandar el valor directamente en el body
      body: JSON.stringify(JSON.stringify(value)),
    }
  );
}

function emptyState() {
  return { operations: [], expenses: [], incomes: [], monthHistory: [], updatedAt: Date.now() };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(500).json({ error: 'UPSTASH no configurado.' });
  }

  try {
    // ── GET ──
    if (req.method === 'GET') {
      let state = await redisGet(USER_KEY);
      if (!state || typeof state !== 'object') state = emptyState();
      // Aseguramos que todas las propiedades existen
      state.operations   = state.operations   || [];
      state.expenses     = state.expenses     || [];
      state.incomes      = state.incomes      || [];
      state.monthHistory = state.monthHistory || [];
      return res.status(200).json(state);
    }

    // ── POST ──
    if (req.method === 'POST') {
      const { action, data } = req.body || {};
      let state = await redisGet(USER_KEY);
      if (!state || typeof state !== 'object') state = emptyState();
      state.operations   = state.operations   || [];
      state.expenses     = state.expenses     || [];
      state.incomes      = state.incomes      || [];
      state.monthHistory = state.monthHistory || [];

      if (action === 'save') {
        const newState = {
          operations:   Array.isArray(data?.operations)   ? data.operations   : state.operations,
          expenses:     Array.isArray(data?.expenses)     ? data.expenses     : state.expenses,
          incomes:      Array.isArray(data?.incomes)      ? data.incomes      : state.incomes,
          monthHistory: Array.isArray(data?.monthHistory) ? data.monthHistory : state.monthHistory,
          updatedAt: Date.now(),
        };
        await redisSet(USER_KEY, newState);
        return res.status(200).json({ ok: true });
      }

      if (action === 'close_month') {
        const now = new Date();
        const label = now.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
        const totalIncome  = state.incomes.reduce((s, i) => s + Number(i.amount || 0), 0);
        const totalExpense = state.expenses.reduce((s, e) => s + Number(e.amount || 0), 0);

        const closedMonth = {
          id: Date.now(),
          label,
          closedAt: now.toISOString(),
          incomes:  state.incomes,
          expenses: state.expenses,
          totalIncome,
          totalExpense,
          balance: totalIncome - totalExpense,
        };

        const newState = {
          operations:   state.operations,
          expenses:     [],
          incomes:      [],
          monthHistory: [closedMonth, ...state.monthHistory],
          updatedAt: Date.now(),
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