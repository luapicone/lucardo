/**
 * storage.js
 * Persistencia en localStorage con fallback seguro.
 * Exporta el objeto `db` con el estado de la app.
 */

const STORAGE_KEY = 'fintrack-v3';

const db = {
  operations: [],   // { id, name, ticker, type, quantity, buyPrice, date }
  expenses:   [],   // { id, name, amount, category, date }
  incomes:    [],   // { id, name, amount, category, date }
};

/**
 * Carga el estado guardado desde localStorage.
 * Si no hay nada o hay error, usa el estado vacío por defecto.
 */
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.operations) db.operations = parsed.operations;
      if (parsed.expenses)   db.expenses   = parsed.expenses;
      if (parsed.incomes)    db.incomes    = parsed.incomes;
    }
  } catch (e) {
    console.warn('FinTrack: no se pudo cargar el estado guardado.', e);
  }
}

/**
 * Persiste el estado actual en localStorage.
 */
function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      operations: db.operations,
      expenses:   db.expenses,
      incomes:    db.incomes,
    }));
  } catch (e) {
    console.error('FinTrack: error al guardar el estado.', e);
  }
}

/**
 * Genera un ID único basado en timestamp + random.
 */
function generateId() {
  return Date.now() + Math.floor(Math.random() * 1000);
}

/**
 * Fecha actual formateada para Argentina.
 */
function todayStr() {
  return new Date().toLocaleDateString('es-AR');
}

/**
 * Agrega una operación de inversión.
 */
function addOperation(data) {
  const op = {
    id:        generateId(),
    name:      data.name,
    ticker:    data.ticker.toUpperCase(),
    type:      data.type || 'accion',
    quantity:  Number(data.quantity),
    buyPrice:  Number(data.buyPrice),
    date:      todayStr(),
  };
  db.operations.push(op);
  saveState();
  return op;
}

/**
 * Agrega un gasto.
 */
function addExpense(data) {
  const exp = {
    id:       generateId(),
    name:     data.name,
    amount:   Number(data.amount),
    category: data.category || 'otro',
    date:     todayStr(),
  };
  db.expenses.push(exp);
  saveState();
  return exp;
}

/**
 * Agrega un ingreso.
 */
function addIncome(data) {
  const inc = {
    id:       generateId(),
    name:     data.name,
    amount:   Number(data.amount),
    category: data.category || 'otro',
    date:     todayStr(),
  };
  db.incomes.push(inc);
  saveState();
  return inc;
}

/**
 * Elimina una operación por ID.
 */
function deleteOperation(id) {
  db.operations = db.operations.filter(o => o.id !== id);
  saveState();
}

/**
 * Elimina un gasto por ID.
 */
function deleteExpense(id) {
  db.expenses = db.expenses.filter(e => e.id !== id);
  saveState();
}

/**
 * Elimina un ingreso por ID.
 */
function deleteIncome(id) {
  db.incomes = db.incomes.filter(i => i.id !== id);
  saveState();
}
