/**
 * api/db.js — Upstash Redis backend
 * Compatible con datos guardados con doble o simple serialización.
 */

const USER_KEY = 'fintrack:main';

async function redisRequest(path, options = {}) {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  return res.json();
}

async function redisGet(key) {
  const data = await redisRequest(`/get/${encodeURIComponent(key)}`);
  const raw = data.result;
  if (!raw) return null;

  // Maneja doble o simple serialización
  let parsed = raw;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  return parsed;
}

async function redisSet(key, value) {
  // Guarda como string JSON simple (una sola capa)
  await redisRequest(`/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    body: JSON.stringify(JSON.stringify(value)),
  });
}

function emptyState() {
  return { operations: [], expenses: [], incomes: [], monthHistory: [], updatedAt: Date.now() };
}

function normalizeState(state) {
  if (!state || typeof state !== 'object') return emptyState();
  return {
    operations:   Array.isArray(state.operations)   ? state.operations   : [],
    expenses:     Array.isArray(state.expenses)     ? state.expenses     : [],
    incomes:      Array.isArray(state.incomes)      ? state.incomes      : [],
    monthHistory: Array.isArray(state.monthHistory) ? state.monthHistory : [],
    updatedAt:    state.updatedAt || Date.now(),
  };
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
    if (req.method === 'GET') {
      const raw = await redisGet(USER_KEY);
      return res.status(200).json(normalizeState(raw));
    }

    if (req.method === 'POST') {
      const { action, data } = req.body || {};
      const state = normalizeState(await redisGet(USER_KEY));

      if (action === 'save') {
        const newState = normalizeState({ ...state, ...data, updatedAt: Date.now() });
        await redisSet(USER_KEY, newState);
        return res.status(200).json({ ok: true });
      }

      if (action === 'close_month') {
        const now = new Date();
        const label = now.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
        const totalIncome  = state.incomes.reduce((s, i)  => s + Number(i.amount  || 0), 0);
        const totalExpense = state.expenses.reduce((s, e) => s + Number(e.amount || 0), 0);

        const closedMonth = {
          id: Date.now(), label,
          closedAt: now.toISOString(),
          incomes: state.incomes,
          expenses: state.expenses,
          totalIncome, totalExpense,
          balance: totalIncome - totalExpense,
        };

        const newState = {
          operations:   state.operations,
          expenses:     [],
          incomes:      [],
          monthHistory: [closedMonth, ...state.monthHistory],
          updatedAt:    Date.now(),
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