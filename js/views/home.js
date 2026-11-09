import { rpc } from '../sb.js';
import { esc, store } from '../ui.js';

export async function mount(main) {
  main.innerHTML = `
    <div class="hero">
      <img src="icons/icon.svg" alt="">
      <h1>hide<b>&amp;</b>seek</h1>
      <p class="muted">Verstecken, suchen, Fragen stellen.</p>
    </div>
    <div id="resume"></div>
    <div class="stack mt2">
      <a class="btn big block" href="#/join">Spiel beitreten</a>
      <a class="btn big block navy" href="#/create">Spiel anlegen</a>
    </div>
    <div class="card flat mt2 small">
      <h3>So geht's</h3>
      <p>Eine Partei versteckt sich im Spielfeld, die anderen suchen. Die Sucher stellen über die App Fragen
        und bezahlen mit Münzen. Die Hider würfeln mit den Münzen Blockaden, die die Sucher aufhalten.
        Je länger die Suche dauert, desto mehr Minuten bekommen die Hider. Wer am Ende die meisten Minuten hat, gewinnt.</p>
    </div>`;

  const last = store.get('lastGame');
  if (!last) return;
  try {
    const g = await rpc('check_game', { p_id: last });
    if (g.found && g.joined && g.status !== 'finished') {
      main.querySelector('#resume').innerHTML = `
        <a class="card accent row" href="#/g/${esc(g.id)}" style="text-decoration:none">
          <div class="grow"><div class="muted small">Weiterspielen</div><strong>${esc(g.title)}</strong></div>
          <span class="id-pill">${esc(g.id)}</span>
        </a>`;
    }
  } catch { /* egal */ }
}
