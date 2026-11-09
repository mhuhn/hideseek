// Kleine UI-Helfer: Escaping, Toasts, Dialoge, Zeitformat, Live-Timer

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function setTopbarRight(html = '') { $('#topbar-right').innerHTML = html; }

export function setTabbar(html) {
  const bar = $('#tabbar');
  if (html) { bar.innerHTML = html; bar.hidden = false; document.body.classList.add('has-tabbar'); }
  else { bar.innerHTML = ''; bar.hidden = true; document.body.classList.remove('has-tabbar'); }
}

export const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem('hs.' + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('hs.' + key, JSON.stringify(value)); } catch { /* privat-Modus */ }
  },
  del(key) { try { localStorage.removeItem('hs.' + key); } catch { /* egal */ } },
};

// ---------------------------------------------------------------- Toasts
export function toast(msg, type = '') {
  const root = $('#toast-root');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 5000 : 3200);
}

export function showError(e) {
  console.error(e);
  toast(e?.message || String(e), 'error');
}

// ---------------------------------------------------------------- Modal
export function openModal(html, { dismissable = true, onClose } = {}) {
  const root = $('#modal-root');
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => { back.remove(); onClose?.(); };
  if (dismissable) back.addEventListener('click', (e) => { if (e.target === back) close(); });
  back.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  root.appendChild(back);
  return { el: back.firstElementChild, close };
}

export function confirmDialog(title, text, okLabel = 'Ja', okClass = '') {
  return new Promise((resolve) => {
    let answered = false;
    const m = openModal(`
      <h2>${esc(title)}</h2>
      ${text ? `<p>${text}</p>` : ''}
      <div class="btn-row mt2">
        <button class="btn ghost" data-close>Abbrechen</button>
        <button class="btn ${okClass}" data-ok>${esc(okLabel)}</button>
      </div>`, { onClose: () => { if (!answered) resolve(false); } });
    m.el.querySelector('[data-ok]').addEventListener('click', () => { answered = true; m.close(); resolve(true); });
  });
}

export function alertDialog(title, html, okLabel = 'Verstanden') {
  return new Promise((resolve) => {
    const m = openModal(`<h2>${esc(title)}</h2>${html}
      <button class="btn block big mt2" data-close>${esc(okLabel)}</button>`, { onClose: resolve });
    return m;
  });
}

/** Button während einer async-Aktion sperren */
export async function busy(btn, fn) {
  if (btn?.disabled) return;
  const label = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }
  try { return await fn(); }
  catch (e) { showError(e); }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = label; } }
}

// ---------------------------------------------------------------- Zeit
let clockOffset = 0;   // Serverzeit - Gerätezeit
export function setServerNow(iso) { clockOffset = Date.parse(iso) - Date.now(); }
export function serverNow() { return Date.now() + clockOffset; }

export function fmtClock(ms) {
  const neg = ms < 0;
  let s = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const t = h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  return neg ? '-' + t : t;
}

export function fmtDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '';
}

export function fmtMeters(m) {
  return m >= 1000 ? `${(m / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} km` : `${Math.round(m)} m`;
}

/**
 * Elemente mit data-until="<ISO>" zählen herunter, data-since="<ISO>" zählen hoch.
 * onZero wird einmal aufgerufen, wenn ein Countdown 0 erreicht.
 */
let tickTimer = null;
const firedZero = new Set();
export function startTimers(onZero) {
  stopTimers();
  const tick = () => {
    const now = serverNow();
    for (const el of $$('[data-until]')) {
      const left = Date.parse(el.dataset.until) - now;
      el.textContent = fmtClock(Math.max(0, left));
      if (left <= 0 && !firedZero.has(el.dataset.until)) { firedZero.add(el.dataset.until); onZero?.(); }
    }
    for (const el of $$('[data-since]')) el.textContent = fmtClock(now - Date.parse(el.dataset.since));
  };
  tick();
  tickTimer = setInterval(tick, 1000);
  return tick;
}
export function stopTimers() { if (tickTimer) clearInterval(tickTimer); tickTimer = null; }

// ---------------------------------------------------------------- Feedback
export function buzz(pattern = [200, 100, 200]) {
  try { navigator.vibrate?.(pattern); } catch { /* iOS kann das nicht */ }
  try {
    const ctx = buzz.ctx || (buzz.ctx = new (window.AudioContext || window.webkitAudioContext)());
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.value = 880; g.gain.value = 0.08;
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.18);
  } catch { /* kein Audio */ }
}

export function initials(name) {
  return (name || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

const PARTY_COLORS = ['#ff6b35', '#2ec4b6', '#5b5fef', '#e63973', '#3a86ff', '#8ac926', '#9b5de5', '#f7b801', '#1d2b53', '#00a6a6', '#c2410c', '#64748b'];
export function partyColor(n) { return PARTY_COLORS[((n || 1) - 1) % PARTY_COLORS.length]; }
