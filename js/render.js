/**
 * render.js
 * Todas las funciones que actualizan el DOM.
 * Depende de: storage.js (db), prices.js (calcPnl, getCurrentPrice)
 */

/* ── COLORES PARA CATEGORÍAS ── */
const CAT_COLORS = [
  '#22c55e', '#3b82f6', '#f97316', '#a855f7',
  '#eab308', '#ec4899', '#14b8a6', '#6366f1',
  '#ef4444', '#84cc16',
];

const TYPE_COLORS = {
  accion:  '#3b82f6',
  etf:     '#a855f7',
  cripto:  '#f97316',
  bono:    '#eab308',
  fondo:   '#14b8a6',
  otro:    '#6b7280',
};

/* ── FORMATEO ── */
function fmt(n, decimals = 0) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return '$' + Number(n).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtNum(n, decimals = 2) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtPct(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${Number(n).toFixed(2)}%`;
}

function pnlClass(n) {
  if (n === null || n === undefined) return '';
  return n >= 0 ? 'positive' : 'negative';
}

function pnlSign(n) {
  return n >= 0 ? '+' : '';
}

/* ── TOTALES ── */
function calcTotals() {
  let totalInvested = 0, totalCurrent = 0;

  db.operations.forEach(op => {
    const { currentValue } = calcPnl(op);
    totalInvested += op.quantity * op.buyPrice;
    totalCurrent  += currentValue;
  });

  const pnl     = totalCurrent - totalInvested;
  const pnlPct  = totalInvested > 0 ? (pnl / totalInvested) * 100 : 0;
  const income  = db.incomes.reduce((s, i) => s + Number(i.amount), 0);
  const expense = db.expenses.reduce((s, e) => s + Number(e.amount), 0);
  const balance = income - expense;

  return { totalInvested, totalCurrent, pnl, pnlPct, income, expense, balance };
}

/* ── RENDER SUMMARY CARDS ── */
function renderSummary() {
  const { totalInvested, totalCurrent, pnl, pnlPct, income, expense, balance } = calcTotals();

  setText('d-capital',     fmt(totalCurrent));
  setText('d-invested',    fmt(totalInvested));
  setText('d-inv-count',   `${db.operations.length} operaciones`);
  setText('d-income',      fmt(income));
  setText('d-income-count',`${db.incomes.length} registros`);
  setText('d-expenses',    fmt(expense));
  setText('d-exp-count',   `${db.expenses.length} transacciones`);

  const pnlEl = document.getElementById('d-pnl');
  if (pnlEl) {
    pnlEl.textContent = `${pnlSign(pnl)}${fmt(pnl)}`;
    pnlEl.className = `metric-value ${pnlClass(pnl)}`;
  }

  setText('d-pnl-pct', fmtPct(pnlPct));
  const pnlPctEl = document.getElementById('d-pnl-pct');
  if (pnlPctEl) pnlPctEl.className = `metric-sub ${pnlClass(pnlPct)}`;

  const balEl = document.getElementById('d-balance');
  if (balEl) {
    balEl.textContent = `${pnlSign(balance)}${fmt(balance)}`;
    balEl.className = `metric-value ${pnlClass(balance)}`;
  }
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

/* ── RENDER OPERACIONES (tabla completa) ── */
function renderOpsTable() {
  const tbody = document.getElementById('ops-tbody');
  const footer = document.getElementById('ops-footer');
  const badge = document.getElementById('ops-badge');

  if (badge) badge.textContent = db.operations.length;

  if (!db.operations.length) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="11" class="empty-state">Sin operaciones. Usá el chat para agregar.</td></tr>';
    if (footer) footer.innerHTML = '';
    return;
  }

  if (tbody) {
    tbody.innerHTML = db.operations.map(op => {
      const { currentPrice, currentValue, pnl, pnlPct, hasPnl } = calcPnl(op);
      const invested = op.quantity * op.buyPrice;
      const color = TYPE_COLORS[op.type] || TYPE_COLORS.otro;

      return `<tr>
        <td>
          <span class="type-dot" style="background:${color}"></span>
          <span class="asset-name">${escHtml(op.name)}</span>
        </td>
        <td><span class="ticker-chip">${escHtml(op.ticker)}</span></td>
        <td class="r">${fmtNum(op.quantity, op.quantity % 1 === 0 ? 0 : 4)}</td>
        <td class="r">${fmt(op.buyPrice, 2)}</td>
        <td class="r">${fmt(invested)}</td>
        <td class="r">${hasPnl ? fmt(currentPrice, 2) : '<span class="price-loading">cargando…</span>'}</td>
        <td class="r">${hasPnl ? fmt(currentValue) : '—'}</td>
        <td class="r ${pnlClass(pnl)}">${hasPnl ? `${pnlSign(pnl)}${fmt(pnl)}` : '—'}</td>
        <td class="r ${pnlClass(pnlPct)}">${hasPnl ? fmtPct(pnlPct) : '—'}</td>
        <td class="r" style="color:var(--text-tertiary);font-size:11px">${op.date}</td>
        <td class="r"><button class="del-btn" onclick="handleDeleteOp(${op.id})">×</button></td>
      </tr>`;
    }).join('');
  }

  /* Footer con totales */
  const { totalInvested, totalCurrent, pnl, pnlPct } = calcTotals();
  if (footer) {
    footer.innerHTML = `
      <div class="footer-stat">
        <div class="footer-label">Total invertido</div>
        <div class="footer-value">${fmt(totalInvested)}</div>
      </div>
      <div class="footer-stat">
        <div class="footer-label">Capital actual</div>
        <div class="footer-value">${fmt(totalCurrent)}</div>
      </div>
      <div class="footer-stat">
        <div class="footer-label">PnL general</div>
        <div class="footer-value ${pnlClass(pnl)}">${pnlSign(pnl)}${fmt(pnl)} (${fmtPct(pnlPct)})</div>
      </div>`;
  }
}

/* ── RENDER DASHBOARD — ops mini ── */
function renderDashOps() {
  const el = document.getElementById('dash-ops-list');
  if (!el) return;

  if (!db.operations.length) {
    el.innerHTML = '<p class="empty-state">Sin operaciones. Usá el chat para agregar.</p>';
    return;
  }

  el.innerHTML = db.operations.slice(-5).reverse().map(op => {
    const { currentValue, pnl, pnlPct, hasPnl } = calcPnl(op);
    const color = TYPE_COLORS[op.type] || TYPE_COLORS.otro;

    return `<div class="row-item">
      <div class="row-left">
        <span class="type-dot" style="background:${color}"></span>
        <div>
          <div class="row-name">${escHtml(op.name)} <span class="ticker-chip">${op.ticker}</span></div>
          <div class="row-sub">${op.quantity} u · compra ${fmt(op.buyPrice, 2)}</div>
        </div>
      </div>
      <div style="text-align:right">
        <div class="row-value ${pnlClass(pnl)}">${hasPnl ? `${pnlSign(pnl)}${fmt(pnl)}` : '…'}</div>
        <div class="row-sub">${hasPnl ? fmtPct(pnlPct) : '—'}</div>
      </div>
    </div>`;
  }).join('');
}

/* ── RENDER GASTOS ── */
function renderExpenses(fullListId, barsId) {
  const listEl = document.getElementById(fullListId);
  const barsEl = document.getElementById(barsId);

  if (listEl) {
    if (!db.expenses.length) {
      listEl.innerHTML = '<p class="empty-state">Sin gastos.</p>';
    } else {
      listEl.innerHTML = db.expenses.slice().reverse().map((exp, i) => `
        <div class="row-item">
          <div class="row-left">
            <span class="cat-dot" style="background:${CAT_COLORS[i % CAT_COLORS.length]}"></span>
            <div>
              <div class="row-name">${escHtml(exp.name)}</div>
              <div class="row-sub">${exp.category} · ${exp.date}</div>
            </div>
          </div>
          <div class="row-actions">
            <span class="row-value">${fmt(exp.amount)}</span>
            <button class="del-btn" onclick="handleDeleteExpense(${exp.id})">×</button>
          </div>
        </div>`).join('');
    }
  }

  if (barsEl) renderBars(barsEl, db.expenses, 'category', 'amount');
}

/* ── RENDER INGRESOS ── */
function renderIncomes(fullListId, barsId) {
  const listEl = document.getElementById(fullListId);
  const barsEl = document.getElementById(barsId);

  if (listEl) {
    if (!db.incomes.length) {
      listEl.innerHTML = '<p class="empty-state">Sin ingresos.</p>';
    } else {
      listEl.innerHTML = db.incomes.slice().reverse().map(inc => `
        <div class="row-item">
          <div class="row-left">
            <span class="cat-dot" style="background:var(--green)"></span>
            <div>
              <div class="row-name">${escHtml(inc.name)}</div>
              <div class="row-sub">${inc.category} · ${inc.date}</div>
            </div>
          </div>
          <div class="row-actions">
            <span class="row-value positive">${fmt(inc.amount)}</span>
            <button class="del-btn" onclick="handleDeleteIncome(${inc.id})">×</button>
          </div>
        </div>`).join('');
    }
  }

  if (barsEl) renderBars(barsEl, db.incomes, 'category', 'amount', '#22c55e');
}

/* ── RENDER BARRAS ── */
function renderBars(el, items, catKey, amtKey, forceColor = null) {
  if (!items.length) {
    el.innerHTML = '<p class="empty-state">Sin datos.</p>';
    return;
  }

  const totals = {};
  items.forEach(it => {
    const cat = it[catKey] || 'otro';
    totals[cat] = (totals[cat] || 0) + Number(it[amtKey]);
  });

  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const max = sorted[0][1];

  el.innerHTML = sorted.map(([cat, amt], i) => `
    <div class="bar-row">
      <div class="bar-label">${cat}</div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${Math.round((amt / max) * 100)}%;background:${forceColor || CAT_COLORS[i % CAT_COLORS.length]}"></div>
      </div>
      <div class="bar-value">${fmt(amt)}</div>
    </div>`).join('');
}

/* ── RENDER DISTRIBUCIÓN PORTAFOLIO ── */
function renderPortfolioDist() {
  const el = document.getElementById('dash-portfolio-dist');
  if (!el) return;

  if (!db.operations.length) {
    el.innerHTML = '<p class="empty-state">Sin operaciones.</p>';
    return;
  }

  const totals = {};
  let grandTotal = 0;

  db.operations.forEach(op => {
    const { currentValue } = calcPnl(op);
    totals[op.ticker] = (totals[op.ticker] || 0) + currentValue;
    grandTotal += currentValue;
  });

  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const colors = Object.keys(TYPE_COLORS);

  el.innerHTML = sorted.map(([ticker, val], i) => {
    const pct = grandTotal > 0 ? (val / grandTotal) * 100 : 0;
    const color = CAT_COLORS[i % CAT_COLORS.length];
    return `<div class="dist-row">
      <div class="dist-name">
        <span class="type-dot" style="background:${color}"></span>
        ${ticker}
      </div>
      <div style="display:flex;align-items:center;gap:12px">
        <div class="bar-track" style="width:80px">
          <div class="bar-fill" style="width:${Math.round(pct)}%;background:${color}"></div>
        </div>
        <div class="dist-pct">${pct.toFixed(1)}%</div>
      </div>
    </div>`;
  }).join('');
}

/* ── RENDER EVERYTHING ── */
function renderAll() {
  renderSummary();
  renderDashOps();
  renderOpsTable();
  renderExpenses('dash-exp-bars', 'dash-exp-bars'); /* dashboard bars */
  renderExpenses('exp-full-list', 'exp-full-bars');
  renderIncomes('dash-inc-list', null);
  renderIncomes('inc-full-list', 'inc-full-bars');
  renderPortfolioDist();

  /* Las barras del dashboard tienen IDs separados */
  renderBars(
    document.getElementById('dash-exp-bars'),
    db.expenses, 'category', 'amount'
  );
  renderBars(
    document.getElementById('dash-inc-list'),
    db.incomes, 'category', 'amount', '#22c55e'
  );
}

/* ── HANDLERS GLOBALES (llamados desde onclick inline) ── */
function handleDeleteOp(id) {
  deleteOperation(id);
  renderAll();
}

function handleDeleteExpense(id) {
  deleteExpense(id);
  renderAll();
}

function handleDeleteIncome(id) {
  deleteIncome(id);
  renderAll();
}

/* ── UTILIDADES ── */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
