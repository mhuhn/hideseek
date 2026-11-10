import { configured, ensureSession } from './sb.js';
import { $, esc, showError, setTopbarRight, setTabbar } from './ui.js';
import * as home from './views/home.js';
import * as join from './views/join.js';
import * as create from './views/create.js';
import * as game from './views/game.js';

const main = $('#main');
let current = null;

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'create') return { view: create, args: {} };
  if (parts[0] === 'join') return { view: join, args: { id: parts[1] } };
  if (parts[0] === 'g' && parts[1]) return { view: game, args: { id: parts[1].toUpperCase() } };
  return { view: home, args: {} };
}

async function route() {
  try { current?.unmount?.(); } catch (e) { console.error(e); }
  setTopbarRight('');
  setTabbar('');
  main.innerHTML = '';
  document.getElementById('main').scrollTo(0, 0);

  if (!configured) {
    main.innerHTML = `<div class="hero"><img src="icons/icon.svg" alt=""><h1>hide<b>&amp;</b>seek</h1></div>
      <div class="banner warn">Die App ist noch nicht mit Supabase verbunden. Trage URL und Publishable Key in <code>js/config.js</code> ein.</div>`;
    return;
  }

  const { view, args } = parseRoute();
  current = view;
  try {
    await ensureSession();
    await view.mount(main, args);
  } catch (e) {
    showError(e);
    main.innerHTML = `<div class="banner danger">${esc(e.message)}</div>
      <a class="btn block" href="#/">Zur Startseite</a>`;
  }
}

window.addEventListener('hashchange', route);
route();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
