import { rpc } from '../sb.js';
import { esc, store, busy, fmtDateTime } from '../ui.js';

export async function mount(main, { id }) {
  main.innerHTML = `
    <h1>Spiel beitreten</h1>
    <div class="card">
      <form id="f-id">
        <label class="field"><span>Spiel-ID</span>
          <input class="code" id="gid" type="text" inputmode="text" autocomplete="off" autocapitalize="characters"
                 maxlength="5" pattern="[0-9A-Fa-f]{5}" placeholder="A1B2C" value="${esc(id || '')}">
          <small>5 Zeichen (0–9 und A–F), die dir der Spielleiter sagt.</small>
        </label>
        <button class="btn block big" type="submit">Weiter</button>
      </form>
      <div id="msg"></div>
    </div>
    <div id="step2"></div>`;

  const inp = main.querySelector('#gid');
  inp.addEventListener('input', () => { inp.value = inp.value.toUpperCase().replace(/[^0-9A-F]/g, ''); });
  main.querySelector('#f-id').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, () => check(main, inp.value));
  });
  if (id && /^[0-9A-Fa-f]{5}$/.test(id)) check(main, id);
  else inp.focus();
}

async function check(main, raw) {
  const msg = main.querySelector('#msg');
  const step2 = main.querySelector('#step2');
  msg.innerHTML = ''; step2.innerHTML = '';
  if (!/^[0-9A-F]{5}$/i.test(raw)) { msg.innerHTML = '<div class="banner warn mt">Die ID hat genau 5 Zeichen aus 0–9 und A–F.</div>'; return; }

  const g = await rpc('check_game', { p_id: raw });
  if (!g.found) { msg.innerHTML = `<div class="banner danger mt">Es gibt kein Spiel mit der ID ${esc(raw.toUpperCase())}.</div>`; return; }
  if (g.joined) { location.hash = '#/g/' + g.id; return; }
  if (g.status !== 'lobby') { msg.innerHTML = '<div class="banner danger mt">Dieses Spiel hat schon begonnen oder ist vorbei.</div>'; return; }
  if (!g.open) {
    msg.innerHTML = `<div class="banner warn mt">Das Spiel „${esc(g.title)}“ ist gerade nicht geöffnet.
      ${g.earliest_at ? `<br>Frühestens: ${esc(fmtDateTime(g.earliest_at))}` : ''}
      ${g.latest_at ? `<br>Spätestens: ${esc(fmtDateTime(g.latest_at))}` : ''}</div>`;
    return;
  }
  if (g.full) { msg.innerHTML = '<div class="banner danger mt">Das Spiel ist schon voll.</div>'; return; }

  step2.innerHTML = `
    <div class="card">
      <div class="muted small">Spiel</div>
      <h2>${esc(g.title)}</h2>
      <form id="f-name">
        <label class="field"><span>Dein Name</span>
          <input id="pname" type="text" maxlength="24" autocomplete="nickname" required value="${esc(store.get('name', ''))}">
        </label>
        <button class="btn block big green" type="submit">Mitspielen</button>
      </form>
    </div>`;
  const nameInp = step2.querySelector('#pname');
  if (!nameInp.value) nameInp.focus();
  step2.querySelector('#f-name').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const name = nameInp.value.trim();
      const gid = await rpc('join_game', { p_id: g.id, p_name: name });
      store.set('name', name);
      store.set('lastGame', gid);
      location.hash = '#/g/' + gid;
    });
  });
}
