/**
 * app.js
 * Punto de entrada principal. Inicializa la app,
 * conecta los módulos y orquesta el ciclo de actualización.
 */

/* ── AUTO-REFRESH INTERVAL (ms) ── */
const REFRESH_INTERVAL = 60 * 1000; /* 60 segundos */

let refreshTimer = null;

/* ── NAVEGACIÓN DE VISTAS ── */
function showView(viewId) {
  /* Oculta todas las views */
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));

  /* Muestra la seleccionada */
  const view = document.getElementById(`view-${viewId}`);
  if (view) view.classList.add('active');

  /* Actualiza tabs */
  document.querySelectorAll('.tab').forEach(tab => {
    tab.classList.toggle('active', tab.getAttribute('data-view') === viewId);
  });
}

function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const viewId = tab.getAttribute('data-view');
      if (viewId) showView(viewId);
    });
  });
}

/* ── BOTÓN REFRESH ── */
function initRefreshButton() {
  const btn = document.getElementById('refresh-btn');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    btn.classList.add('spinning');
    btn.disabled = true;

    try {
      await refreshAllPrices();
      renderAll();
    } finally {
      btn.classList.remove('spinning');
      btn.disabled = false;
    }
  });
}

/* ── AUTO-REFRESH ── */
function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);

  refreshTimer = setInterval(async () => {
    if (!db.operations.length) return;
    await refreshAllPrices();
    renderAll();
  }, REFRESH_INTERVAL);
}

/* ── INICIALIZACIÓN ── */
async function init() {
  /* 1. Carga datos persistidos */
  loadState();

  /* 2. Render inicial con datos guardados (sin precios aún) */
  renderAll();

  /* 3. Inicializa navegación */
  initTabs();
  initRefreshButton();

  /* 4. Inicializa chat */
  initChat();

  /* 5. Obtiene precios en tiempo real */
  if (db.operations.length) {
    const refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) {
      refreshBtn.classList.add('spinning');
      refreshBtn.disabled = true;
    }

    await refreshAllPrices();
    renderAll();

    if (refreshBtn) {
      refreshBtn.classList.remove('spinning');
      refreshBtn.disabled = false;
    }
  }

  /* 6. Inicia el ciclo de auto-refresh */
  startAutoRefresh();

  /* 7. Pausa el refresh cuando la pestaña no está visible */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearInterval(refreshTimer);
    } else {
      /* Al volver, refresca inmediatamente y reinicia el timer */
      if (db.operations.length) {
        refreshAllPrices().then(() => renderAll());
      }
      startAutoRefresh();
    }
  });

  console.log('FinTrack iniciado correctamente.');
}

/* ── ARRANCAR CUANDO EL DOM ESTÉ LISTO ── */
document.addEventListener('DOMContentLoaded', init);
