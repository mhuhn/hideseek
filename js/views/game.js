/* global L */
import { rpc } from '../sb.js';
import {
  $, $$, esc, store, toast, busy, confirmDialog, alertDialog, setTopbarRight, setTabbar,
  setServerNow, serverNow, startTimers, stopTimers, buzz, initials, partyColor, fmtMeters, fmtDateTime,
} from '../ui.js';
import { startGeo, stopGeo, setUploader, getPos, freshPos, onPosition, distance, inGeometry, getGeoError, geoErrorText } from '../geo.js';
import { CATEGORIES, QUESTIONS, BLOCKADES, DIE, questionText, questionAvailable, blockadeText } from '../catalog.js';
import { captureAndUpload, hydratePhotos, photoTag, openDrawing, zoomPhoto } from '../photo.js';
import { createMap, fieldLayer, dotIcon, placeIcon, markerSet } from '../mapview.js';
import { nearestStreet, countLetters } from '../osm.js';

let main; let view; let mapwrap;
let gameId;
let st = null;            // letzter Zustand vom Server
let lastSig = '';
let pollTimer = null;
let polling = false;
let tab = 'play';
let field = null;         // GeoJSON-Geometrie des Spielfelds
let map = null; let setMarkers = null; let zoneCircle = null;
let seen = null;          // für Benachrichtigungen
let offPos = null;
const suggestTried = new Set();
const lobby = { mode: null, count: 2, draft: {} };

// =============================================================== Lebenszyklus

export async function mount(el, { id }) {
  main = el;
  gameId = id;
  st = null; lastSig = ''; tab = 'play'; seen = null; field = null;
  store.set('lastGame', id);
  setTopbarRight(`<span class="id-pill">${esc(id)}</span>`);
  main.innerHTML = `<div id="view"><div class="center mt2"><span class="spinner"></span></div></div>
    <div id="mapwrap" class="hidden"><div class="map" id="gmap"></div></div>`;
  view = $('#view', main);
  mapwrap = $('#mapwrap', main);
  main.addEventListener('click', onClick);
  $('#tabbar').addEventListener('click', onTab);

  const f = await rpc('get_field', { p_game: id }).catch((e) => {
    if (/nicht angemeldet/.test(e.message)) {
      view.innerHTML = `<div class="banner warn">Du bist in diesem Spiel noch nicht angemeldet.</div>
        <a class="btn block big" href="#/join/${esc(id)}">Beitreten</a>`;
      return null;
    }
    throw e;
  });
  if (!f) return;
  field = f.field;

  startGeo();
  offPos = onPosition(() => { if (st) { updateMap(); updatePosHints(); } });
  setUploader((p) => rpc('update_position', { p_game: gameId, p_lat: p.lat, p_lng: p.lng, p_accuracy: p.acc }));

  await poll();
  pollTimer = setInterval(poll, 3000);
  startTimers(() => setTimeout(poll, 800));
  document.addEventListener('visibilitychange', onVisible);
}

export function unmount() {
  clearInterval(pollTimer); pollTimer = null;
  stopTimers();
  stopGeo();
  offPos?.();
  main?.removeEventListener('click', onClick);
  $('#tabbar').removeEventListener('click', onTab);
  document.removeEventListener('visibilitychange', onVisible);
  map?.remove(); map = null; setMarkers = null; zoneCircle = null;
}

function onVisible() { if (document.visibilityState === 'visible') poll(); }

async function poll() {
  if (polling || !gameId) return;
  polling = true;
  try {
    const s = await rpc('get_state', { p_game: gameId });
    setServerNow(s.now);
    $('#offline')?.remove();
    onState(s);
  } catch (e) {
    if (!$('#offline') && view) view.insertAdjacentHTML('afterbegin', `<div id="offline" class="banner warn">${esc(e.message)}</div>`);
  } finally {
    polling = false;
  }
}

const refresh = () => setTimeout(poll, 150);

// =============================================================== Hilfen

const me = () => st.me;
const round = () => st.round;
const partyOf = (id) => st.parties.find((p) => p.id === id);
const membersOf = (id) => st.players.filter((p) => p.party_id === id);
const playerName = (id) => st.players.find((p) => p.id === id)?.name || '?';
const playing = () => st.players.filter((p) => p.plays);
const isHider = () => st.me.role === 'hider';
const isSeeker = () => st.me.role === 'seeker';
const isSpectator = () => st.me.role === 'spectator';
const endgame = () => !!st.round?.endgame_at;

function partyBadge(p) {
  if (!p) return '';
  return `<span class="badge" style="background:${partyColor(p.number)};color:#fff">${esc(p.name)}</span>`;
}

function partyLabel(p) {
  if (!p) return '?';
  return st.game.team_mode ? `Team ${p.number}` : p.name;
}

function activeBlockadeFor(partyId) {
  return st.blockades?.find((b) => b.party_id === partyId && b.status === 'active');
}

// =============================================================== Zustand verarbeiten

function onState(s) {
  const prev = st;
  st = s;
  notify(prev, s);

  const { now, positions, ...rest } = s;
  const sig = JSON.stringify(rest) + '|' + tab;
  if (sig !== lastSig) {
    lastSig = sig;
    render();
  }
  updateMap();
  updatePosHints();

  // Vorschläge für Straßenfragen berechnen (nur auf Hider-Geräten)
  if (isHider() && s.round?.status === 'seeking') {
    for (const q of s.questions) {
      if (q.status === 'pending' && QUESTIONS[q.qkey]?.type === 'suggest' && !q.suggestion) computeSuggestion(q);
    }
  }
}

function notify(prev, s) {
  const r = s.round;
  if (!seen || !prev) {
    seen = {
      round: r?.id, status: r?.status, endgame: !!r?.endgame_at,
      questions: new Set((s.questions || []).map((q) => q.id + q.status)),
      blockades: new Set((s.blockades || []).map((b) => b.id + b.status)),
    };
    return;
  }
  if (r && r.id !== seen.round) {
    seen.round = r.id; seen.status = r.status; seen.endgame = false;
    if (s.game.status === 'playing') { buzz(); toast(`Runde ${r.number} beginnt`, 'ok'); }
  } else if (r && r.status !== seen.status) {
    seen.status = r.status;
    if (r.status === 'hiding') { buzz(); toast(s.me.role === 'hider' ? 'Los, versteckt euch!' : 'Die Hider verstecken sich jetzt.'); }
    if (r.status === 'seeking') { buzz([300, 100, 300]); toast(s.me.role === 'hider' ? 'Die Suche beginnt!' : 'Los geht\'s – sucht die Hider!', 'ok'); }
  }
  if (r?.endgame_at && !seen.endgame) {
    seen.endgame = true;
    if (s.me.role === 'hider') {
      buzz([400, 150, 400, 150, 400]);
      alertDialog('Endspiel!', '<p>Ein Seeker-Team ist in eure Zielzone gekommen.</p><p><strong>Begebt euch jetzt in ein festes Versteck und bewegt euch nicht mehr davon weg.</strong></p>');
    } else if (s.me.role === 'seeker') {
      toast('Endspiel! Die Endspiel-Fragen sind freigeschaltet.', 'ok');
    }
  }
  for (const q of s.questions || []) {
    const k = q.id + q.status;
    if (seen.questions.has(k)) continue;
    seen.questions.add(k);
    if (s.me.role === 'hider' && q.status === 'pending') { buzz(); toast('Neue Frage!'); }
    if (s.me.role === 'seeker' && q.status === 'answered' && !q.auto) {
      buzz([150]);
      toast(q.answer ? `Antwort: ${q.answer}` : 'Die Hider haben geantwortet.', 'ok');
    }
    if (s.me.role === 'seeker' && q.status === 'expired') toast('Die Hider haben nicht rechtzeitig geantwortet.');
  }
  for (const b of s.blockades || []) {
    const k = b.id + b.status;
    if (seen.blockades.has(k)) continue;
    seen.blockades.add(k);
    if (s.me.role === 'seeker' && b.status === 'active' && b.party_id === s.me.party_id) {
      buzz([500, 200, 500]);
      alertDialog(`Blockade: ${BLOCKADES[b.value].name}`, `<p>${esc(blockadeText(b.value, s.game))}</p>
        <p class="muted small">Solange die Blockade läuft, könnt ihr keine Fragen stellen.</p>`);
    }
    if (s.me.role === 'seeker' && b.status === 'done' && b.party_id === s.me.party_id) toast('Blockade vorbei – ihr könnt wieder fragen.', 'ok');
    if (s.me.role === 'hider' && b.status === 'done' && b.note) toast(`Erkenntnis von ${partyLabel(partyOf(b.party_id))}: ${b.note}`);
  }
}

// =============================================================== Rendern

function render() {
  // Karte vor dem Neuzeichnen in Sicherheit bringen
  main.appendChild(mapwrap);
  const keep = {};
  for (const el of $$('[data-keep]', view)) keep[el.dataset.keep] = el.value;
  const focused = document.activeElement?.dataset?.keep;

  let html; let tabs = null;
  const g = st.game;
  if (g.status === 'lobby') html = renderLobby();
  else if (g.status === 'finished') html = renderFinished();
  else {
    tabs = tabList();
    if (!tabs.some((t) => t.id === tab)) tab = 'play';
    if (tab === 'map') html = renderMapTab();
    else if (tab === 'score') html = renderScore();
    else if (tab === 'dice') html = renderDice();
    else html = renderPlay();
  }
  view.innerHTML = html;

  for (const el of $$('[data-keep]', view)) if (keep[el.dataset.keep] !== undefined) el.value = keep[el.dataset.keep];
  if (focused) $(`[data-keep="${focused}"]`, view)?.focus();

  setTabbar(tabs ? tabs.map((t) => `
    <button data-tab="${t.id}" class="${t.id === tab ? 'on' : ''}">${t.icon}<span>${t.label}</span>${t.dot ? '<i class="dot"></i>' : ''}</button>`).join('') : '');

  const slot = $('[data-map-slot]', view);
  if (slot) {
    slot.appendChild(mapwrap);
    mapwrap.classList.remove('hidden');
    $('#gmap', mapwrap).className = 'map ' + (slot.dataset.mapSlot || '');
    ensureMap();
    setTimeout(() => map?.invalidateSize(), 50);
  } else {
    mapwrap.classList.add('hidden');
  }
  hydratePhotos(view);
  updatePosHints();
  startTimers(() => setTimeout(poll, 800));
}

const ICONS = {
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  hide: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12s3.5-7 9-7 9 7 9 7-3.5 7-9 7-9-7-9-7z"/><circle cx="12" cy="12" r="3"/></svg>',
  dice: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8.5" cy="8.5" r="1.2" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/></svg>',
  map: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 4-6 2v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/></svg>',
  score: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/></svg>',
};

function tabList() {
  const r = round();
  const pending = (st.questions || []).filter((q) => q.status === 'pending').length;
  const tabs = [{ id: 'play', label: isHider() ? 'Fragen' : 'Spiel', icon: isHider() ? ICONS.hide : ICONS.play, dot: isHider() && pending > 0 && tab !== 'play' }];
  if (isHider() && r?.status === 'seeking') tabs.push({ id: 'dice', label: 'Würfeln', icon: ICONS.dice });
  tabs.push({ id: 'map', label: 'Karte', icon: ICONS.map });
  tabs.push({ id: 'score', label: 'Stand', icon: ICONS.score });
  return tabs;
}

// --------------------------------------------------------------- Lobby

function renderLobby() {
  const g = st.game;
  const players = st.players;
  const n = playing().length;
  const admin = me().is_admin;
  const link = `${location.origin}${location.pathname}#/join/${g.id}`;

  let adminHtml = '';
  if (admin) {
    adminHtml = renderTeamSetup(n);
  } else {
    adminHtml = `<div class="banner info">Warte, bis der Spielleiter das Spiel startet.</div>
      <button class="btn ghost block" data-act="leave">Spiel verlassen</button>`;
  }

  return `
    <div class="card accent">
      <div class="muted small">Spiel</div>
      <h1 style="margin:0 0 4px">${esc(g.title)}</h1>
      <div class="muted small">${g.earliest_at || g.latest_at
        ? `Start ${g.earliest_at ? 'ab ' + esc(fmtDateTime(g.earliest_at)) : ''} ${g.latest_at ? 'bis ' + esc(fmtDateTime(g.latest_at)) : ''}`
        : 'Jederzeit startbar'}</div>
    </div>
    <div class="card center">
      <div class="muted small">Spiel-ID zum Mitmachen</div>
      <div class="bigid">${esc(g.id)}</div>
      <div class="btn-row">
        <button class="btn light" data-act="share" data-link="${esc(link)}">Einladen</button>
      </div>
    </div>
    <div class="card">
      <div class="row between"><h3>Mitspieler</h3><span class="badge ${n >= g.min_players ? 'green' : 'orange'}">${n} / ${g.max_players}</span></div>
      <ul class="list">${players.map((p) => `
        <li><span class="avatar">${esc(initials(p.name))}</span>
          <span class="grow">${esc(p.name)}${p.id === me().id ? ' <span class="muted">(du)</span>' : ''}</span>
          ${p.is_admin ? '<span class="badge orange">Spielleiter</span>' : ''}
          ${!p.plays ? '<span class="badge">schaut zu</span>' : ''}</li>`).join('')}</ul>
      ${n < g.min_players ? `<p class="muted small mt">Es fehlen noch ${g.min_players - n} Spieler.</p>` : ''}
    </div>
    ${adminHtml}
    <div class="card"><h3>Spielfeld</h3><div data-map-slot="small"></div></div>
    <div class="card flat small">
      <strong>Regeln</strong><br>
      Versteckzeit ${g.hide_minutes} min · Zielzone ${g.zone_radius_m} m · Antwortzeit ${g.answer_minutes} min
      ${g.places?.length ? `<br>Orte: ${g.places.map((p) => esc(p.name)).join(', ')}` : ''}
      ${g.landmark ? `<br>Zeichnen: ${esc(g.landmark)}` : ''}
    </div>
    ${admin ? '<button class="btn ghost block" data-act="finish">Spiel absagen</button>' : ''}`;
}

function renderTeamSetup(n) {
  const g = st.game;
  const players = playing();
  const fixed = n < 4 ? 'single' : n > 6 ? 'teams' : null;
  const mode = fixed || lobby.mode || 'single';
  const maxTeams = Math.max(2, Math.min(n, 8));
  lobby.count = Math.min(Math.max(2, lobby.count), maxTeams);

  // Zuordnung vervollständigen
  const valid = new Set(players.map((p) => p.id));
  for (const k of Object.keys(lobby.draft)) if (!valid.has(k)) delete lobby.draft[k];
  for (const p of players) {
    if (!(lobby.draft[p.id] >= 1 && lobby.draft[p.id] <= lobby.count)) {
      const sizes = Array.from({ length: lobby.count }, (_, i) => players.filter((x) => lobby.draft[x.id] === i + 1).length);
      lobby.draft[p.id] = sizes.indexOf(Math.min(...sizes)) + 1;
    }
  }
  const empty = mode === 'teams' && Array.from({ length: lobby.count }, (_, i) => i + 1).some((t) => !players.some((p) => lobby.draft[p.id] === t));

  let teamsHtml = '';
  if (mode === 'teams') {
    teamsHtml = `
      <div class="row between mt"><strong>Anzahl Teams</strong>
        <div class="seg">${Array.from({ length: maxTeams - 1 }, (_, i) => i + 2).map((k) =>
          `<button data-act="teamcount" data-n="${k}" class="${k === lobby.count ? 'on' : ''}">${k}</button>`).join('')}</div></div>
      <ul class="list mt">${players.map((p) => `
        <li><span class="grow">${esc(p.name)}</span>
          <div class="seg">${Array.from({ length: lobby.count }, (_, i) => i + 1).map((t) =>
            `<button data-act="assign" data-p="${p.id}" data-n="${t}" class="${lobby.draft[p.id] === t ? 'on' : ''}"
              style="${lobby.draft[p.id] === t ? `background:${partyColor(t)};color:#fff` : ''}">${t}</button>`).join('')}</div></li>`).join('')}</ul>
      ${empty ? '<div class="banner warn mt">Jedes Team braucht mindestens einen Spieler.</div>' : ''}`;
  }

  return `
    <div class="card">
      <h3>Spiel starten</h3>
      ${fixed === 'single' ? '<p class="muted small">Bei weniger als 4 Spielern spielt jeder für sich.</p>' : ''}
      ${fixed === 'teams' ? '<p class="muted small">Bei mehr als 6 Spielern wird in Teams gespielt.</p>' : ''}
      ${!fixed ? `<div class="seg"><button data-act="mode" data-m="single" class="${mode === 'single' ? 'on' : ''}">Jeder für sich</button>
        <button data-act="mode" data-m="teams" class="${mode === 'teams' ? 'on' : ''}">In Teams</button></div>` : ''}
      ${teamsHtml}
      <p class="muted small mt">Wer zuerst Hider ist, lost die App beim Start aus.</p>
      <button class="btn green block big mt" data-act="start" ${n < g.min_players || empty ? 'disabled' : ''}>
        ${n < g.min_players ? `Noch ${g.min_players - n} Spieler nötig` : 'Spiel starten'}</button>
    </div>`;
}

// --------------------------------------------------------------- Teams-Übersicht

function teamsList(highlightHider = true) {
  const r = round();
  return st.parties.map((p) => `
    <div class="row" style="padding:8px 0;border-top:1px solid var(--line)">
      <span class="avatar" style="background:${partyColor(p.number)}">${st.game.team_mode ? p.number : esc(initials(p.name))}</span>
      <div class="grow">
        <strong>${esc(st.game.team_mode ? `Team ${p.number}` : p.name)}</strong>
        ${st.game.team_mode ? `<div class="small muted">${membersOf(p.id).map((m) => esc(m.name)).join(', ')}</div>` : ''}
      </div>
      ${highlightHider && r?.hider_party_id === p.id ? '<span class="badge orange">versteckt sich</span>' : ''}
      ${p.id === me().party_id ? '<span class="badge">du</span>' : ''}
    </div>`).join('');
}

function lastResult() {
  const h = st.history?.[st.history.length - 1];
  if (!h) return '';
  const hider = partyOf(h.hider_party_id); const finder = partyOf(h.found_by_party_id);
  return `<div class="card">
    <div class="muted small">Ergebnis Runde ${h.number}</div>
    <h3>${esc(partyLabel(finder))} hat ${esc(partyLabel(hider))} nach ${h.seek_minutes} ${h.seek_minutes === 1 ? 'Minute' : 'Minuten'} gefunden</h3>
    <p class="small">${esc(partyLabel(hider))} bekommt <strong>${h.seek_minutes * 3} min</strong>, ${esc(partyLabel(finder))} <strong>${h.seek_minutes} min</strong>.</p>
    ${h.proof_path ? photoTag(h.proof_path, 'Beweisfoto') : ''}
  </div>`;
}

// --------------------------------------------------------------- Spiel-Tab

function renderPlay() {
  const r = round();
  if (r.status === 'ready') return renderReady();
  if (r.status === 'hiding') return renderHiding();
  if (r.status === 'seeking') {
    if (isHider()) return renderHiderSeeking();
    if (isSeeker()) return renderSeekerSeeking();
    return renderSpectatorSeeking();
  }
  return '<div class="banner info">Einen Moment …</div>';
}

function roundHead(extra = '') {
  const r = round();
  const hider = partyOf(r.hider_party_id);
  return `<div class="card ${isHider() ? 'accent' : 'navy'}">
    <div class="row between"><div class="muted small">Runde ${r.number} von ${st.parties.length}</div>${extra}</div>
    <h2 style="margin:2px 0 0">${isHider() ? 'Ihr versteckt euch' : isSeeker() ? 'Ihr sucht' : 'Du schaust zu'}</h2>
    <div class="small muted">Hider: ${esc(partyLabel(hider))}${st.game.team_mode ? ` (${membersOf(hider?.id).map((m) => esc(m.name)).join(', ')})` : ''}</div>
  </div>`;
}

function renderReady() {
  const r = round();
  const readyIds = new Set(r.ready);
  const amReady = readyIds.has(me().id);
  const total = playing().length;
  let btn = '';
  if (me().plays && !amReady) {
    btn = isHider()
      ? '<button class="btn big block green" data-act="ready">Wir sind bereit – los!</button>'
      : '<button class="btn big block green" data-act="ready">Bereit! Ich sehe die Hider nicht mehr</button>';
  } else {
    btn = `<div class="banner info">Warte auf die anderen … (${readyIds.size} von ${total} bereit)</div>`;
  }
  return `
    ${lastResult()}
    ${roundHead()}
    <div class="card">
      <h3>Teams</h3>
      ${teamsList()}
    </div>
    <div class="card">
      <h3>Bereit?</h3>
      <p class="small">${isHider()
        ? `Sobald alle bereit sind, habt ihr <strong>${st.game.hide_minutes} Minuten</strong>, um euch im Spielfeld zu verstecken.`
        : 'Bestätige erst, wenn du die Hider nicht mehr sehen kannst. Dann haben sie Zeit, sich zu verstecken.'}</p>
      <ul class="list">${playing().map((p) => `<li><span class="grow">${esc(p.name)}</span>
        ${readyIds.has(p.id) ? '<span class="badge green">bereit</span>' : '<span class="badge">wartet</span>'}</li>`).join('')}</ul>
      <div class="mt">${btn}</div>
    </div>`;
}

function renderHiding() {
  const r = round();
  const over = Date.parse(r.hide_deadline) <= serverNow();
  if (isHider()) {
    return `${roundHead()}
      <div class="card center">
        <div class="muted small">Versteckzeit</div>
        <div class="timer" data-until="${r.hide_deadline}"></div>
        ${over ? '<p class="small mt">Die Zeit ist um – euer aktueller Standort wird zum Versteck.</p>' : ''}
      </div>
      <div id="poshint"></div>
      <div class="card">
        <p class="small">Versteckt euch im Spielfeld. Ein Umkreis von <strong>${st.game.zone_radius_m} m</strong> um euer Versteck ist die Zielzone.
          Spätestens nach Ablauf der Zeit wird eure Position als Versteck gesetzt.</p>
        <button class="btn big block green" data-act="hidden">Wir sind im Versteck</button>
      </div>
      <div data-map-slot="small"></div>`;
  }
  return `${roundHead()}
    <div class="card center">
      <div class="muted small">Die Hider verstecken sich noch</div>
      <div class="timer" data-until="${r.hide_deadline}"></div>
      ${over ? '<p class="small mt">Gleich geht es los …</p>' : ''}
    </div>
    <div class="banner info">Bleibt, wo ihr seid, und schaut nicht, wohin die Hider gehen. Sobald sie versteckt sind, könnt ihr Fragen stellen.</div>
    ${isSpectator() ? `<div class="card"><h3>Teams</h3>${teamsList()}</div>` : ''}`;
}

// --------------------------------------------------------------- Seeker

function seekTimer() {
  const r = round();
  return `<div class="card center">
    <div class="muted small">Suchzeit</div>
    <div class="timer mid" data-since="${r.seeking_started_at}"></div>
    ${endgame() ? '<span class="badge red mt">Endspiel</span>' : ''}
  </div>`;
}

function blockadeCardSeeker(b) {
  const def = BLOCKADES[b.value];
  let action = '';
  if (def.minutes && !def.note) {
    action = `<div class="center mt"><div class="muted small">noch</div><div class="timer mid" data-until="${b.ends_at}"></div></div>`;
  } else if (def.note) {
    const waiting = Date.parse(b.ends_at) > serverNow();
    action = `
      ${waiting ? `<div class="center mt"><div class="muted small">Riechen …</div><div class="timer mid" data-until="${b.ends_at}"></div></div>` : ''}
      <label class="field mt"><span>Eure Erkenntnis für die Hider</span>
        <textarea data-keep="note-${b.id}" maxlength="200" placeholder="Was habt ihr gelernt?"></textarea></label>
      <button class="btn block" data-act="complete" data-b="${b.id}">Erkenntnis senden</button>`;
  } else {
    action = `${def.draw ? `<button class="btn block light mt" data-act="draw">Zeichenfläche öffnen</button>` : ''}
      <button class="btn block green mt" data-act="complete" data-b="${b.id}">${esc(def.done)}</button>`;
  }
  return `<div class="blk active">
    <div class="row"><span class="num">${b.value}</span><h3 style="margin:0">Blockade: ${esc(def.name)}</h3></div>
    <p class="mt">${esc(blockadeText(b.value, st.game))}</p>
    ${action}
  </div>`;
}

function renderSeekerSeeking() {
  const myQ = Object.fromEntries((st.questions || []).map((q) => [q.qkey, q]));
  const pending = (st.questions || []).find((q) => q.status === 'pending');
  const blk = activeBlockadeFor(me().party_id);
  const cooldown = st.endgame_ready_at && Date.parse(st.endgame_ready_at) > serverNow() ? st.endgame_ready_at : null;
  const blocked = !!pending || !!blk;

  const cats = CATEGORIES.map((c) => {
    const locked = c.endgame && !endgame();
    const qs = c.questions.filter((q) => questionAvailable(q, st.game));
    const note = locked
      ? '<p class="small muted">Erst im Endspiel – wenn ein Such-Team in die Zielzone der Hider kommt.</p>'
      : c.endgame && cooldown ? `<p class="small muted">Nächste Endspiel-Frage in <span data-until="${cooldown}"></span></p>` : '';
    return `<div class="qcat">
      <div class="qcat-head"><h3>${esc(c.name)}</h3><span class="badge yellow coin">${c.cost}</span></div>
      ${note}
      ${qs.map((q) => {
        const asked = myQ[q.key];
        const text = esc(questionText(q.key, st.game));
        if (asked) return `<div class="q asked">${text}${answerHtml(asked)}</div>`;
        const dis = locked || blocked || (c.endgame && cooldown);
        return `<button class="q" data-act="ask" data-k="${q.key}" ${dis ? 'disabled' : ''}>${text}</button>`;
      }).join('')}
    </div>`;
  }).join('');

  return `
    ${roundHead()}
    ${seekTimer()}
    ${blk ? blockadeCardSeeker(blk) : ''}
    ${pending ? `<div class="card q-incoming">
      <div class="row between"><span class="muted small">Warte auf Antwort</span><span class="timer sm" data-until="${pending.deadline}"></span></div>
      <h3 class="mt">${esc(questionText(pending.qkey, st.game))}</h3></div>` : ''}
    <div class="card">
      <h2>Fragen</h2>
      <p class="small muted">Jede Frage einmal pro Runde. Die Hider bekommen die angegebenen Münzen – damit würfeln sie Blockaden gegen euch.</p>
      ${cats}
    </div>
    <button class="btn red big block" data-act="found">Gefunden!</button>`;
}

function answerHtml(q) {
  if (q.status === 'pending') return '<span class="ans none">wartet auf Antwort …</span>';
  if (q.status === 'expired') return '<span class="ans none">keine Antwort</span>';
  return `${q.answer ? `<span class="ans">${esc(q.answer)}</span>` : ''}${q.answer_path ? photoTag(q.answer_path) : ''}`;
}

// --------------------------------------------------------------- Hider

function renderHiderSeeking() {
  const qs = st.questions || [];
  const pending = qs.filter((q) => q.status === 'pending').sort((a, b) => a.deadline.localeCompare(b.deadline));
  const done = qs.filter((q) => q.status !== 'pending');
  const notes = (st.blockades || []).filter((b) => b.note);
  return `
    ${roundHead()}
    ${endgame() ? '<div class="banner danger pulse">Endspiel! Bleibt in eurem festen Versteck und bewegt euch nicht mehr weg.</div>' : ''}
    <div id="poshint"></div>
    ${seekTimer()}
    ${pending.length ? pending.map(incomingQuestion).join('') : '<div class="banner info">Gerade gibt es keine offene Frage.</div>'}
    ${notes.length ? `<div class="card"><h3>Erkenntnisse</h3>${notes.map((b) =>
      `<p><strong>${esc(partyLabel(partyOf(b.party_id)))}:</strong> ${esc(b.note)}</p>`).join('')}</div>` : ''}
    ${done.length ? `<div class="card"><h3>Bisherige Fragen</h3>${done.map((q) => `
      <div style="padding:8px 0;border-top:1px solid var(--line)">
        <div class="row between"><span class="small">${partyBadge(partyOf(q.party_id))}</span>
          <span class="badge yellow coin">${q.status === 'answered' ? '+' + q.cost : '0'}</span></div>
        <div class="mt">${esc(questionText(q.qkey, st.game))}</div>
        ${answerHtml(q)}
      </div>`).join('')}</div>` : ''}`;
}

function incomingQuestion(q) {
  const def = QUESTIONS[q.qkey];
  const head = `
    <div class="row between"><span>${partyBadge(partyOf(q.party_id))}</span><span class="timer sm" data-until="${q.deadline}"></span></div>
    <h3 class="mt">${esc(questionText(q.qkey, st.game))}</h3>
    <div class="small muted">Antwortet für <span class="coin">${q.cost}</span> Münzen</div>`;
  let body = '';
  if (def.type === 'photo') {
    body = `<button class="btn block big mt" data-act="photo-answer" data-q="${q.id}" data-facing="${def.facing || 'environment'}">
      ${def.facing === 'user' ? 'Selfie aufnehmen' : 'Foto aufnehmen'}</button>`;
  } else if (def.type === 'yesno' || def.yesno) {
    const sug = q.suggestion?.text;
    body = `${def.type === 'suggest' ? suggestionLine(q) : ''}
      <div class="btn-row mt">
        <button class="btn ${sug === 'Ja' ? 'green' : 'ghost'}" data-act="answer" data-q="${q.id}" data-val="Ja">Ja</button>
        <button class="btn ${sug === 'Nein' ? 'green' : 'ghost'}" data-act="answer" data-q="${q.id}" data-val="Nein">Nein</button>
      </div>`;
  } else if (def.type === 'suggest') {
    body = `${suggestionLine(q)}
      ${q.suggestion?.text ? `<button class="btn block green mt" data-act="answer" data-q="${q.id}" data-val="${esc(q.suggestion.text)}">Vorschlag senden: ${esc(q.suggestion.text)}</button>` : ''}
      <div class="row mt"><input type="text" class="grow" data-keep="ans-${q.id}" maxlength="100" placeholder="${q.suggestion?.text ? 'Korrigieren …' : 'Antwort eingeben'}">
        <button class="btn navy" data-act="answer" data-q="${q.id}">Senden</button></div>`;
  } else {
    body = `<div class="row mt"><input type="text" class="grow" data-keep="ans-${q.id}" maxlength="140" placeholder="Antwort">
      <button class="btn" data-act="answer" data-q="${q.id}">Senden</button></div>`;
  }
  return `<div class="card q-incoming">${head}${body}</div>`;
}

function suggestionLine(q) {
  if (!q.suggestion) return '<p class="small muted mt"><span class="spinner" style="width:14px;height:14px;border-width:2px"></span> Die App sucht die nächste Straße …</p>';
  const info = q.suggestion.info ? ` (nächste Straße: ${esc(q.suggestion.info)})` : '';
  if (!q.suggestion.text) return `<p class="small muted mt">Kein Vorschlag möglich${info}. Bitte selbst antworten.</p>`;
  return `<p class="small mt">Vorschlag der App: <strong>${esc(q.suggestion.text)}</strong>${info}. Prüft ihn kurz – ohne Antwort wird er nach Ablauf der Zeit gesendet.</p>`;
}

// --------------------------------------------------------------- Würfeln (Hider)

function renderDice() {
  const coins = st.coins || [];
  const choosing = (st.blockades || []).find((b) => b.status === 'choosing');
  return `
    ${endgame() ? '<div class="banner danger">Endspiel – jetzt geht auch die Blockade „Flucht“.</div>' : ''}
    ${choosing ? `<div class="card q-incoming"><h3>Auswahl!</h3>
      <p>Gewürfelt: <span class="dice sm">${choosing.rolls.map((d) => `<span>${DIE[d]}</span>`).join('')}</span>
      – gegen ${esc(partyLabel(partyOf(choosing.party_id)))}. Welche Blockade nehmt ihr?</p>
      <div class="btn-row">${choosing.options.map((v) => `<button class="btn" data-act="choose" data-b="${choosing.id}" data-v="${v}">${v} · ${esc(BLOCKADES[v].name)}</button>`).join('')}</div>
    </div>` : ''}
    <p class="small muted">Mit den Münzen eines Teams könnt ihr Blockaden gegen genau dieses Team würfeln. 1 Würfel kostet 10, 2 Würfel kosten 20 Münzen.</p>
    ${coins.map((c) => diceCard(c, !!choosing)).join('') || '<div class="banner info">Noch keine Seeker-Teams.</div>'}`;
}

function diceCard(c, choosing) {
  const p = partyOf(c.party_id);
  const all = (st.blockades || []).filter((b) => b.party_id === c.party_id);
  const held = all.filter((b) => b.status === 'held');
  const active = all.find((b) => b.status === 'active');
  const history = all.filter((b) => b.status === 'done' || b.status === 'void');
  return `<div class="card">
    <div class="row between"><h3 style="margin:0">${partyBadge(p)}</h3><span class="badge yellow coin" style="font-size:16px">${c.coins}</span></div>
    ${st.game.team_mode ? `<div class="small muted mt">${membersOf(p.id).map((m) => esc(m.name)).join(', ')}</div>` : ''}
    ${c.choice_token ? '<div class="banner ok mt small">Auswahl aktiv: Beim nächsten Wurf dürft ihr ±1 wählen.</div>' : ''}
    <div class="btn-row mt">
      <button class="btn" data-act="roll" data-p="${c.party_id}" data-d="1" ${c.coins < 10 || choosing ? 'disabled' : ''}>1 Würfel · 10</button>
      <button class="btn navy" data-act="roll" data-p="${c.party_id}" data-d="2" ${c.coins < 20 || choosing ? 'disabled' : ''}>2 Würfel · 20</button>
    </div>
    ${active ? `<div class="blk active mt"><div class="row"><span class="num">${active.value}</span><strong class="grow">${esc(BLOCKADES[active.value].name)} läuft</strong>
      ${active.ends_at && BLOCKADES[active.value].minutes ? `<span class="timer sm" data-until="${active.ends_at}"></span>` : ''}</div></div>` : ''}
    ${held.length ? `<h3 class="mt">Eure Blockaden</h3>${held.map((b) => {
      const def = BLOCKADES[b.value];
      const noFlee = def.endgame && !endgame();
      return `<div class="blk"><div class="row"><span class="num">${b.value}</span><strong class="grow">${esc(def.name)}</strong>
        <button class="btn small" data-act="play" data-b="${b.id}" ${active || noFlee ? 'disabled' : ''}>Einsetzen</button></div>
        <p class="small mt">${esc(blockadeText(b.value, st.game))}</p>
        ${noFlee ? '<p class="small muted">Erst im Endspiel einsetzbar.</p>' : ''}
        ${active ? '<p class="small muted">Erst wenn die laufende Blockade vorbei ist.</p>' : ''}</div>`;
    }).join('')}` : ''}
    ${history.length ? `<p class="small muted mt">Bisher: ${history.map((b) => `${b.value} ${esc(BLOCKADES[b.value]?.name || '')}`).join(' · ')}</p>` : ''}
  </div>`;
}

// --------------------------------------------------------------- Zuschauer

function renderSpectatorSeeking() {
  const qs = st.questions || [];
  return `${roundHead()}${seekTimer()}
    ${endgame() ? '<div class="banner danger">Endspiel läuft.</div>' : ''}
    <div class="card"><h3>Münzen der Hider</h3>${(st.coins || []).map((c) =>
      `<div class="row between" style="padding:6px 0">${partyBadge(partyOf(c.party_id))}<span class="badge yellow coin">${c.coins}</span></div>`).join('')}</div>
    <div class="card"><h3>Fragen</h3>${qs.map((q) => `
      <div style="padding:8px 0;border-top:1px solid var(--line)">
        <span class="small">${partyBadge(partyOf(q.party_id))}</span>
        <div class="mt">${esc(questionText(q.qkey, st.game))}</div>${answerHtml(q)}</div>`).join('') || '<p class="muted">Noch keine Fragen.</p>'}</div>
    <div class="card"><h3>Blockaden</h3>${(st.blockades || []).filter((b) => b.value).map((b) =>
      `<p class="small">${partyBadge(partyOf(b.party_id))} ${b.value} ${esc(BLOCKADES[b.value].name)} – ${{ held: 'auf der Hand', active: 'läuft', done: 'erledigt', void: '—', choosing: 'wird gewählt' }[b.status]}</p>`).join('') || '<p class="muted">Noch keine.</p>'}</div>`;
}

// --------------------------------------------------------------- Karte, Stand, Ende

function renderMapTab() {
  const parts = ['<span class="row small"><span class="pos-dot" style="width:12px;height:12px;border-width:2px"></span> du</span>'];
  if (st.parties.length) parts.push('<span class="row small"><span class="mate-dot" style="width:12px;height:12px;border-width:2px"></span> dein Team</span>');
  if (isHider() || isSpectator()) parts.push('<span class="row small"><span style="width:12px;height:12px;border-radius:50%;background:rgba(214,58,58,.25);border:2px solid #d63a3a;display:inline-block"></span> Zielzone</span>');
  return `<div id="poshint"></div>
    <div data-map-slot="tall"></div>
    <div class="row wrap mt" style="gap:14px">${parts.join('')}</div>`;
}

function ranking() {
  return [...st.parties].sort((a, b) => b.minutes - a.minutes || a.number - b.number);
}

function renderScore() {
  const ranked = ranking();
  const hist = st.history || [];
  return `<div class="card"><h2>Stand</h2>
    ${ranked.map((p, i) => `<div class="score ${i === 0 && p.minutes > 0 ? 'top' : ''}">
      <span class="rank">${i + 1}</span>
      <div class="grow">${partyBadge(p)}
        ${st.game.team_mode ? `<div class="small muted">${membersOf(p.id).map((m) => esc(m.name)).join(', ')}</div>` : ''}
        <div class="small muted">${p.was_hider ? 'war schon Hider' : 'war noch nicht Hider'}</div></div>
      <span class="min">${p.minutes} min</span></div>`).join('')}
  </div>
  ${hist.length ? `<div class="card"><h3>Runden</h3>${hist.map((h) => `<p class="small">Runde ${h.number}: ${esc(partyLabel(partyOf(h.found_by_party_id)))} findet ${esc(partyLabel(partyOf(h.hider_party_id)))} nach ${h.seek_minutes} min</p>`).join('')}</div>` : ''}
  <div class="card flat small">Hider bekommen 3 × die Suchminuten, das Team, das sie findet, 1 ×. Es wird gespielt, bis jede Partei einmal Hider war.</div>
  ${me().is_admin ? '<button class="btn ghost block" data-act="finish">Spiel vorzeitig beenden</button>' : ''}`;
}

function renderFinished() {
  if (!st.history?.length) {
    return `<div class="card center"><h2>Spiel abgesagt</h2><p class="muted">Der Spielleiter hat dieses Spiel beendet, bevor eine Runde fertig war.</p></div>
      <a class="btn big block" href="#/">Zur Startseite</a>`;
  }
  const ranked = ranking();
  const top = ranked[0]?.minutes ?? 0;
  const winners = ranked.filter((p) => p.minutes === top && top > 0);
  return `
    <div class="card accent center">
      <div class="muted">Spiel vorbei</div>
      <h1 style="margin:6px 0">${winners.length ? `${winners.map((w) => esc(partyLabel(w))).join(' & ')} ${winners.length > 1 ? 'gewinnen' : 'gewinnt'}!` : 'Unentschieden'}</h1>
      ${winners.length ? `<div>${top} Minuten</div>` : ''}
    </div>
    ${lastResult()}
    <div class="card"><h2>Endstand</h2>
      ${ranked.map((p, i) => `<div class="score ${p.minutes === top && top > 0 ? 'top' : ''}">
        <span class="rank">${i + 1}</span><div class="grow">${partyBadge(p)}
        ${st.game.team_mode ? `<div class="small muted">${membersOf(p.id).map((m) => esc(m.name)).join(', ')}</div>` : ''}</div>
        <span class="min">${p.minutes} min</span></div>`).join('')}
    </div>
    <a class="btn big block" href="#/">Zur Startseite</a>`;
}

// =============================================================== Karte

function ensureMap() {
  if (map) return;
  map = createMap($('#gmap', mapwrap));
  if (field) {
    const lay = fieldLayer(field).addTo(map);
    map.fitBounds(lay.getBounds(), { padding: [10, 10] });
  }
  setMarkers = markerSet(map);
  updateMap();
}

function updateMap() {
  if (!map || !st) return;
  const items = {};
  for (const [i, p] of (st.game.places || []).entries()) items['place' + i] = { lat: p.lat, lng: p.lng, icon: placeIcon(p.name) };
  for (const pos of st.positions || []) {
    if (pos.player_id === me().id) continue;
    items['p' + pos.player_id] = { lat: pos.lat, lng: pos.lng, icon: dotIcon('mate-dot'), label: playerName(pos.player_id), permanent: true };
  }
  const mine = getPos();
  if (mine) items.me = { lat: mine.lat, lng: mine.lng, icon: dotIcon('pos-dot') };
  const hide = st.round?.hide;
  if (hide && (isHider() || isSpectator()) && st.round.status === 'seeking') {
    if (!zoneCircle) {
      zoneCircle = L.circle([hide.lat, hide.lng], { radius: st.game.zone_radius_m, color: '#d63a3a', weight: 2, fillOpacity: 0.12, interactive: false }).addTo(map);
    } else {
      zoneCircle.setLatLng([hide.lat, hide.lng]).setRadius(st.game.zone_radius_m);
    }
  } else if (zoneCircle) { zoneCircle.remove(); zoneCircle = null; }
  setMarkers(items);
}

/** Hinweise zur eigenen Position (außerhalb Spielfeld / Zielzone, kein GPS) */
function updatePosHints() {
  const box = $('#poshint', view);
  if (!box || !st?.round) return;
  const pos = getPos();
  const err = getGeoError();
  let html = '';
  if (!pos) {
    html = err ? `<div class="banner danger">${esc(geoErrorText(err))}</div>` : '<div class="banner warn">Standort wird bestimmt …</div>';
  } else if (isHider()) {
    const hide = st.round.hide;
    if (st.round.status === 'hiding' && field && !inGeometry(pos, field)) {
      html = '<div class="banner danger">Ihr seid außerhalb des Spielfelds!</div>';
    } else if (st.round.status === 'seeking' && hide) {
      const d = distance(pos, hide);
      if (d > st.game.zone_radius_m) html = `<div class="banner danger">Ihr seid ${fmtMeters(d - st.game.zone_radius_m)} außerhalb eurer Zielzone! Geht zurück.</div>`;
    }
    if (pos.acc > 60) html += `<div class="banner warn small">GPS ungenau (±${Math.round(pos.acc)} m).</div>`;
  } else if (field && !inGeometry(pos, field)) {
    html = '<div class="banner warn">Du bist außerhalb des Spielfelds.</div>';
  }
  if (box.innerHTML !== html) box.innerHTML = html;
}

// =============================================================== Straßen-Vorschläge

async function computeSuggestion(q) {
  if (suggestTried.has(q.id)) return;
  suggestTried.add(q.id);
  try {
    const pos = await freshPos(30000);
    const s = await nearestStreet(pos, 300);
    let text = null;
    if (s && q.qkey === 'street_letters') text = `${countLetters(s.name)} Buchstaben`;
    if (s && q.qkey === 'street_dist') text = `Etwa ${Math.round(s.dist / 5) * 5} m`;
    await rpc('set_suggestion', { p_question: q.id, p_text: text, p_info: s?.name || '' });
    refresh();
  } catch (e) {
    console.warn('Vorschlag fehlgeschlagen', e);
    try { await rpc('set_suggestion', { p_question: q.id, p_text: null, p_info: '' }); refresh(); } catch { /* egal */ }
  }
}

// =============================================================== Aktionen

function onTab(e) {
  const b = e.target.closest('[data-tab]');
  if (!b || b.dataset.tab === tab) return;
  tab = b.dataset.tab;
  lastSig = '';
  render();
  document.getElementById('main').scrollTo(0, 0);
}

function onClick(e) {
  const img = e.target.closest('img[data-zoom]');
  if (img?.src) { zoomPhoto(img.src); return; }
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) fn(el, e);
}

const rerender = () => { lastSig = ''; render(); };

const ACTIONS = {
  share: async (el) => {
    const link = el.dataset.link;
    const text = `Spiel mit bei hide&seek! Spiel-ID: ${st.game.id}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'hide&seek', text, url: link }); } catch { /* abgebrochen */ }
    } else {
      try { await navigator.clipboard.writeText(`${text}\n${link}`); toast('Link kopiert', 'ok'); } catch { toast(link); }
    }
  },
  leave: async (el) => {
    if (!await confirmDialog('Spiel verlassen?', '', 'Verlassen', 'red')) return;
    await busy(el, async () => { await rpc('leave_game', { p_game: gameId }); store.del('lastGame'); location.hash = '#/'; });
  },
  finish: async (el) => {
    const lobbyPhase = st.game.status === 'lobby';
    if (!await confirmDialog(lobbyPhase ? 'Spiel absagen?' : 'Spiel beenden?', lobbyPhase ? 'Das Spiel wird für alle Mitspieler beendet.' : 'Das Spiel wird für alle beendet und der aktuelle Stand gilt als Endstand.', lobbyPhase ? 'Absagen' : 'Beenden', 'red')) return;
    await busy(el, async () => { await rpc('end_game', { p_game: gameId }); refresh(); });
  },
  mode: (el) => { lobby.mode = el.dataset.m; rerender(); },
  teamcount: (el) => { lobby.count = +el.dataset.n; rerender(); },
  assign: (el) => { lobby.draft[el.dataset.p] = +el.dataset.n; rerender(); },
  start: async (el) => {
    const n = playing().length;
    const mode = n < 4 ? 'single' : n > 6 ? 'teams' : (lobby.mode || 'single');
    const teams = mode === 'teams' ? Object.fromEntries(playing().map((p) => [p.id, lobby.draft[p.id]])) : null;
    if (!await confirmDialog('Spiel starten?', `${n} Spieler ${mode === 'teams' ? `in ${lobby.count} Teams` : 'spielen jeder für sich'}. Danach kann niemand mehr beitreten.`, 'Starten', 'green')) return;
    await busy(el, async () => { await rpc('start_game', { p_game: gameId, p_teams: teams }); refresh(); });
  },
  ready: (el) => busy(el, async () => { await rpc('confirm_ready', { p_round: round().id }); refresh(); }),
  hidden: async (el) => {
    if (!await confirmDialog('Seid ihr im Versteck?', `Eure aktuelle Position wird zum Versteck. Die Zielzone ist ${st.game.zone_radius_m} m groß.`, 'Ja, wir sind versteckt', 'green')) return;
    await busy(el, async () => {
      const pos = await freshPos(10000);
      await rpc('confirm_hidden', { p_round: round().id, p_lat: pos.lat, p_lng: pos.lng });
      refresh();
    });
  },
  ask: async (el) => {
    const key = el.dataset.k;
    const def = QUESTIONS[key];
    if (!await confirmDialog('Diese Frage stellen?', `„${esc(questionText(key, st.game))}“<br><br>Die Hider bekommen dafür <strong>${def.cost} Münzen</strong>.`, 'Frage stellen')) return;
    await busy(el, async () => {
      const pos = await freshPos(15000);
      let street = null;
      if (key === 'same_street') {
        toast('Suche eure Straße …');
        try { street = (await nearestStreet(pos, 250))?.name || null; } catch { street = null; }
      }
      const q = await rpc('ask_question', { p_round: round().id, p_key: key, p_lat: pos.lat, p_lng: pos.lng, p_street: street });
      if (q.status === 'answered') { buzz([120]); await alertDialog('Antwort', `<p class="muted">${esc(questionText(key, st.game))}</p><p class="timer mid" style="font-size:28px">${esc(q.answer)}</p>`, 'OK'); }
      else toast('Frage gesendet – die Hider haben ' + st.game.answer_minutes + ' Minuten Zeit.', 'ok');
      refresh();
    });
  },
  found: async (el) => {
    if (!await confirmDialog('Gefunden?', 'Habt ihr jemanden aus dem Hider-Team gefunden? Macht jetzt ein Beweisfoto. Danach endet die Runde für alle.', 'Beweisfoto machen', 'red')) return;
    await busy(el, async () => {
      const path = await captureAndUpload(gameId, 'environment');
      if (!path) return;
      await rpc('report_found', { p_round: round().id, p_path: path });
      buzz([300, 100, 300]);
      refresh();
    });
  },
  answer: (el) => busy(el, async () => {
    const qid = el.dataset.q;
    const val = el.dataset.val ?? $(`[data-keep="ans-${qid}"]`, view)?.value ?? '';
    if (!val.trim()) { toast('Bitte gib eine Antwort ein.', 'error'); return; }
    await rpc('answer_question', { p_question: qid, p_text: val.trim(), p_path: null });
    toast('Antwort gesendet', 'ok');
    refresh();
  }),
  'photo-answer': (el) => busy(el, async () => {
    const path = await captureAndUpload(gameId, el.dataset.facing);
    if (!path) return;
    await rpc('answer_question', { p_question: el.dataset.q, p_text: null, p_path: path });
    toast('Foto gesendet', 'ok');
    refresh();
  }),
  roll: (el) => busy(el, async () => {
    const dice = +el.dataset.d;
    const b = await rpc('roll_dice', { p_round: round().id, p_party: el.dataset.p, p_dice: dice });
    showRoll(b, dice);
    refresh();
  }),
  choose: (el) => busy(el, async () => {
    const b = await rpc('choose_blockade', { p_blockade: el.dataset.b, p_value: +el.dataset.v });
    showRoll(b, null);
    refresh();
  }),
  play: async (el) => {
    const b = st.blockades.find((x) => x.id === el.dataset.b);
    if (!await confirmDialog(`${BLOCKADES[b.value].name} einsetzen?`, `Gegen ${esc(partyLabel(partyOf(b.party_id)))}: ${esc(blockadeText(b.value, st.game))}`, 'Einsetzen', 'red')) return;
    await busy(el, async () => { await rpc('play_blockade', { p_blockade: b.id }); toast('Blockade eingesetzt', 'ok'); refresh(); });
  },
  complete: (el) => busy(el, async () => {
    const note = $(`[data-keep="note-${el.dataset.b}"]`, view)?.value || null;
    await rpc('complete_blockade', { p_blockade: el.dataset.b, p_note: note });
    refresh();
  }),
  draw: () => openDrawing(st.game.landmark ? `Zeichnet: ${st.game.landmark}` : 'Zeichnet eine Sehenswürdigkeit'),
};

function showRoll(b, dice) {
  if (b.status === 'choosing') return;   // Auswahl erscheint im Würfeln-Tab
  const def = BLOCKADES[b.value];
  const first = dice ? b.rolls.slice(0, dice) : b.rolls;
  const bonusRolls = [];
  for (let i = dice || b.rolls.length; i < b.rolls.length; i += 2) bonusRolls.push(b.rolls.slice(i, i + 2));
  const diceHtml = (arr) => `<span class="dice">${arr.map((d) => `<span>${DIE[d]}</span>`).join('')}</span>`;
  let html = `<div class="center">${diceHtml(first)}<div class="muted small mt">${first.reduce((a, c) => a + c, 0)} Augen</div>`;
  for (const br of bonusRolls) html += `<p class="mt small"><strong>Bonus!</strong> Nochmal gewürfelt + 2:</p>${diceHtml(br)}`;
  html += `<h2 class="mt">${b.value} · ${esc(def.name)}</h2><p>${esc(blockadeText(b.value, st.game))}</p></div>`;
  if (b.value >= 3) html += '<p class="small muted center">Die Blockade liegt jetzt bei euch und kann jederzeit eingesetzt werden.</p>';
  alertDialog('Gewürfelt', html, 'OK');
}
