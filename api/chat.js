/**
 * chat.js
 * Integración con Claude vía proxy serverless en /api/chat.
 * La API key vive en Vercel como variable de entorno, nunca en el browser.
 * Depende de: storage.js, prices.js, render.js
 */

/* Endpoint del proxy serverless (relativo, funciona en cualquier dominio) */
const API_ENDPOINT = '/api/chat';

/* ── SYSTEM PROMPT ── */
const SYSTEM_PROMPT = `Sos un asistente financiero personal argentino que registra operaciones de inversión, gastos e ingresos.

Analizás el mensaje del usuario y respondés ÚNICAMENTE con JSON puro, sin markdown, sin backticks, sin texto extra.

Formato de respuesta:
{
  "action": "add_operation" | "add_expense" | "add_income" | "query" | "none",
  "data": { ... },
  "reply": "respuesta breve y amigable en español rioplatense"
}

Para add_operation, data debe tener:
  - name: nombre completo del activo (ej: "Apple Inc.", "Bitcoin", "S&P 500 ETF")
  - ticker: símbolo estándar de mercado en mayúsculas (ej: AAPL, BTC, SPY, MELI, NVDA, MSFT, ETH, SOL)
  - quantity: número (puede ser decimal para criptos, ej: 0.5)
  - buyPrice: precio de compra por unidad en USD (número)
  - type: "accion" | "cripto" | "etf" | "bono" | "fondo" | "otro"

Para add_expense, data debe tener:
  - name: descripción del gasto
  - amount: monto en pesos o dólares (número)
  - category: "supermercado" | "restaurantes" | "transporte" | "entretenimiento" | "alquiler" | "servicios" | "salud" | "ropa" | "educación" | "otro"

Para add_income, data debe tener:
  - name: descripción del ingreso
  - amount: monto (número)
  - category: "sueldo" | "freelance" | "alquiler_cobrado" | "dividendos" | "bono" | "venta" | "otro"

Para query: solo incluí reply con un análisis del estado actual.
Para none: solo incluí reply.

Reglas importantes:
- Cuando alguien dice "compré X a $Y" o "tengo X de Z", registrá como operación
- Los tickers deben ser los símbolos reales de mercado
- Para acciones argentinas en MERVAL: GGAL, YPFD, PAMP, BMA, etc.
- Para ADRs argentinos en NYSE: GGAL, YPF, PAM, BMA, LOMA, etc.
- Respondé siempre en español rioplatense, de forma breve y concisa`;

/* ── ESTADO DEL CHAT ── */
const chatHistory = [];

/* ── AGREGAR MENSAJE AL DOM ── */
function appendMessage(text, role) {
  const msgs = document.getElementById('chat-msgs');
  if (!msgs) return null;

  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = text.replace(/\n/g, '<br>').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}

/* ── INDICADOR DE ESCRITURA ── */
function appendTypingIndicator() {
  const msgs = document.getElementById('chat-msgs');
  if (!msgs) return null;

  const div = document.createElement('div');
  div.className = 'msg assistant';
  div.id = 'typing-indicator';
  div.innerHTML = `<div class="typing-dots">
    <div class="typing-dot"></div>
    <div class="typing-dot"></div>
    <div class="typing-dot"></div>
  </div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}

/* ── ENVIAR MENSAJE A CLAUDE ── */
async function sendToClaude(userText) {
  /* Agrega al historial */
  chatHistory.push({ role: 'user', content: userText });

  /* Construye contexto del estado actual */
  const stateContext = `\n\nEstado actual del portafolio:
- Operaciones: ${JSON.stringify(db.operations)}
- Gastos: ${JSON.stringify(db.expenses)}
- Ingresos: ${JSON.stringify(db.incomes)}`;

  const messagesWithContext = chatHistory.map((msg, i) => {
    if (i === chatHistory.length - 1 && msg.role === 'user') {
      return { ...msg, content: msg.content + stateContext };
    }
    return msg;
  });

  const response = await fetch(API_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 800,
      system:     SYSTEM_PROMPT,
      messages:   messagesWithContext,
    }),
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData?.error || `Error ${response.status}`);
  }

  const data = await response.json();
  const rawText = data.content?.[0]?.text || '{}';

  /* Intenta parsear JSON */
  let parsed;
  try {
    const clean = rawText.replace(/```json|```/g, '').trim();
    parsed = JSON.parse(clean);
  } catch {
    parsed = { action: 'none', reply: rawText };
  }

  /* Agrega respuesta al historial */
  chatHistory.push({ role: 'assistant', content: parsed.reply || 'Entendido.' });

  /* Mantiene el historial acotado (últimos 20 mensajes) */
  if (chatHistory.length > 20) chatHistory.splice(0, 2);

  return parsed;
}

/* ── HANDLER PRINCIPAL ── */
async function handleSend() {
  const input   = document.getElementById('chat-input');
  const sendBtn = document.getElementById('send-btn');
  const text    = input?.value?.trim();

  if (!text) return;

  appendMessage(text, 'user');
  input.value = '';
  input.style.height = 'auto';
  sendBtn.disabled = true;

  const typingEl = appendTypingIndicator();

  try {
    const parsed = await sendToClaude(text);
    typingEl?.remove();

    /* Procesa la acción */
    switch (parsed.action) {

      case 'add_operation': {
        if (!parsed.data) break;
        const op = addOperation(parsed.data);
        appendMessage(parsed.reply || 'Operación registrada.', 'assistant');

        /* Busca el precio actual y muestra PnL inmediato */
        const price = await fetchPrice(op.ticker, op.type);
        if (price !== null) {
          priceCache[op.ticker.toUpperCase()] = price;
          const pnl    = op.quantity * (price - op.buyPrice);
          const pnlPct = ((price - op.buyPrice) / op.buyPrice) * 100;
          const sign   = pnl >= 0 ? '+' : '';
          const cls    = pnl >= 0 ? '🟢' : '🔴';
          appendMessage(
            `${cls} <strong>${op.ticker}</strong> cotiza a $${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · PnL: ${sign}$${Math.round(Math.abs(pnl)).toLocaleString()} (${sign}${pnlPct.toFixed(2)}%)`,
            'assistant'
          );
        } else {
          appendMessage(
            `No pude obtener el precio de <strong>${op.ticker}</strong> en este momento. Se va a actualizar automáticamente.`,
            'assistant'
          );
        }
        renderAll();
        break;
      }

      case 'add_expense': {
        if (!parsed.data) break;
        addExpense(parsed.data);
        renderAll();
        appendMessage(parsed.reply || 'Gasto registrado.', 'assistant');
        break;
      }

      case 'add_income': {
        if (!parsed.data) break;
        addIncome(parsed.data);
        renderAll();
        appendMessage(parsed.reply || 'Ingreso registrado.', 'assistant');
        break;
      }

      default:
        appendMessage(parsed.reply || 'Entendido.', 'assistant');
    }

  } catch (err) {
    typingEl?.remove();
    console.error('FinTrack chat error:', err);
    appendMessage('Hubo un error al procesar tu mensaje. Verificá tu conexión e intentá de nuevo.', 'assistant');
  }

  sendBtn.disabled = false;
  input?.focus();
}

/* ── INICIALIZAR EVENTOS DEL CHAT ── */
function initChat() {
  const input   = document.getElementById('chat-input');
  const sendBtn = document.getElementById('send-btn');

  /* Auto-resize del textarea */
  input?.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  /* Enter para enviar (Shift+Enter = nueva línea) */
  input?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  sendBtn?.addEventListener('click', handleSend);

  /* Quick buttons */
  document.querySelectorAll('.qb').forEach(btn => {
    btn.addEventListener('click', () => {
      const msg = btn.getAttribute('data-msg');
      if (msg && input) {
        input.value = msg;
        input.dispatchEvent(new Event('input'));
        handleSend();
      }
    });
  });
}