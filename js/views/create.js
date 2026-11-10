/* global L */
import { rpc } from '../sb.js';
import { $, esc, store, busy, toast, showError } from '../ui.js';
import { createMap, placeIcon, FIELD_STYLE } from '../mapview.js';
import { searchPlaces, loadDistricts, reverseCity } from '../osm.js';

const LEVEL_NAMES = { 7: 'Verbände', 8: 'Gemeinden', 9: 'Bezirke', 10: 'Stadtteile', 11: 'Viertel' };
const STEP_TITLES = ['Grunddaten', 'Stadtteile', 'Eigene Gebiete', 'Orte', 'Regeln'];

let S;          // Zustand des Assistenten
let map = null;
let main;

function freshState() {
  return {
    step: 0,
    title: '', name: store.get('name', ''), plays: true,
    earliest: '', latest: '', min: 3, max: 12,
    city: null,
    levels: {}, level: null, selected: new Set(),
    adds: [], cuts: [],                     // GeoJSON-Geometrien (selbst gezeichnet)
    places: [{ name: '' }, { name: '' }, { name: '' }, { name: '' }],
    landmark: '',
    hide: 12, radius: 200, answer: 3,
  };
}

export function mount(el) {
  main = el;
  S = freshState();
  render();
}

export function unmount() {
  map?.remove();
  map = null;
}

function render() {
  map?.remove();
  map = null;
  main.innerHTML = `
    <h1>Spiel anlegen</h1>
    <div class="steps">${STEP_TITLES.map((_, i) => `<span class="${i <= S.step ? 'on' : ''}"></span>`).join('')}</div>
    <div class="muted small" style="margin-bottom:10px">Schritt ${S.step + 1} von ${STEP_TITLES.length} · ${STEP_TITLES[S.step]}</div>
    <div id="step"></div>`;
  const box = $('#step', main);
  [step0, stepDistricts, stepDraw, step2, step3][S.step](box);
  document.getElementById('main').scrollTo(0, 0);
}

function go(step) { S.step = step; render(); }

// ------------------------------------------------------------- Schritt 1: Grunddaten

function step0(box) {
  box.innerHTML = `
    <form class="card" id="f0">
      <label class="field"><span>Titel des Spiels</span>
        <input type="text" name="title" maxlength="60" required value="${esc(S.title)}" placeholder="z. B. Altstadt-Jagd"></label>
      <label class="field"><span>Dein Name</span>
        <input type="text" name="name" maxlength="24" required value="${esc(S.name)}"></label>
      <label class="check"><input type="checkbox" name="plays" ${S.plays ? 'checked' : ''}> Ich spiele selbst mit</label>
      <div class="two">
        <label class="field"><span>Mindestens Spieler</span>
          <input type="number" name="min" min="2" max="30" value="${S.min}" required></label>
        <label class="field"><span>Höchstens Spieler</span>
          <input type="number" name="max" min="2" max="30" value="${S.max}" required></label>
      </div>
      <label class="field"><span>Frühester Spielbeginn <span class="muted">(optional)</span></span>
        <input type="datetime-local" name="earliest" value="${esc(S.earliest)}"></label>
      <label class="field"><span>Spätester Spielbeginn <span class="muted">(optional)</span></span>
        <input type="datetime-local" name="latest" value="${esc(S.latest)}">
        <small>Nur in diesem Zeitraum kann man beitreten und das Spiel starten.</small></label>
      <button class="btn block big" type="submit">Weiter zum Spielfeld</button>
    </form>`;
  $('#f0', box).addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    S.title = f.get('title').trim();
    S.name = f.get('name').trim();
    S.plays = !!f.get('plays');
    S.min = +f.get('min'); S.max = +f.get('max');
    S.earliest = f.get('earliest'); S.latest = f.get('latest');
    if (S.max < S.min) { toast('Höchstens muss mindestens so groß sein wie Mindestens.', 'error'); return; }
    if (S.earliest && S.latest && S.latest <= S.earliest) { toast('Der späteste Beginn muss nach dem frühesten liegen.', 'error'); return; }
    go(1);
  });
}

// ------------------------------------------------------------- Schritt 2: Stadtteile

const STYLE_SELECTED = { color: '#ff6b35', weight: 2, fillColor: '#ff6b35', fillOpacity: 0.35 };
const STYLE_UNSELECTED = { color: '#1d2b53', weight: 1, fillColor: '#1d2b53', fillOpacity: 0.04, dashArray: '4 4' };

function selectionText() {
  const n = S.selected.size;
  return n ? `${n} ${n === 1 ? 'Stadtteil' : 'Stadtteile'} ausgewählt` : 'Noch keine Stadtteile ausgewählt.';
}

function stepDistricts(box) {
  box.innerHTML = `
    <div class="card">
      <h3>Stadtteile auswählen</h3>
      <p class="muted small">Tippe auf der Karte die Stadtteile an, die zum Spielfeld gehören. Nochmal tippen hebt die Auswahl auf.
        Eigene Gebiete zeichnest du im nächsten Schritt.</p>
      <form class="row" id="f-search">
        <input type="search" id="q" placeholder="Stadt oder Ort" value="${esc(S.city?.short || '')}" class="grow">
        <button class="btn" type="submit">Suchen</button>
      </form>
      <div id="results" class="mt"></div>
      <div id="levels" class="row wrap mt"></div>
    </div>
    <div class="map" id="fmap"></div>
    <div id="summary" class="banner info mt"></div>
    <div class="btn-row mt">
      <button class="btn ghost" data-back>Zurück</button>
      <button class="btn" data-next>Weiter: eigene Gebiete</button>
    </div>`;

  map = createMap($('#fmap', box));
  const districtLayer = L.featureGroup().addTo(map);
  const summary = () => { $('#summary', box).textContent = selectionText(); };

  const drawDistricts = () => {
    districtLayer.clearLayers();
    for (const d of S.levels[S.level] || []) {
      const lay = L.geoJSON(d.geometry, { style: S.selected.has(d.id) ? STYLE_SELECTED : STYLE_UNSELECTED, pmIgnore: true });
      lay.bindTooltip(esc(d.name), { sticky: true, className: 'map-label' });
      lay.on('click', () => {
        if (S.selected.has(d.id)) S.selected.delete(d.id); else S.selected.add(d.id);
        lay.setStyle(S.selected.has(d.id) ? STYLE_SELECTED : STYLE_UNSELECTED);
        summary();
      });
      lay.addTo(districtLayer);
    }
  };

  const drawLevels = () => {
    const lv = Object.keys(S.levels).sort();
    $('#levels', box).innerHTML = lv.length > 1
      ? `<span class="small muted">Einteilung:</span>` + lv.map((l) =>
        `<button class="chip ${l === S.level ? 'on' : ''}" data-level="${l}">${LEVEL_NAMES[l] || 'Ebene ' + l} (${S.levels[l].length})</button>`).join('')
      : '';
  };

  const loadCity = async (place) => {
    S.city = place;
    $('#results', box).innerHTML = '<span class="spinner"></span> Lade Stadtteile von OpenStreetMap … (dauert bis zu 30 Sekunden)';
    const [s, n, w, e] = place.bbox;
    map.fitBounds([[s, w], [n, e]]);
    try {
      S.levels = await loadDistricts(place);
      if (!box.isConnected) return;
      const lv = Object.keys(S.levels);
      S.level = ['10', '9', '11', '8'].find((l) => (S.levels[l]?.length || 0) >= 2) || lv[0] || null;
      S.selected = new Set();
      $('#results', box).innerHTML = lv.length
        ? ''
        : '<div class="banner warn">Für diesen Ort sind keine Stadtteilgrenzen hinterlegt. Zeichne das Spielfeld im nächsten Schritt selbst.</div>';
      drawLevels();
      drawDistricts();
      if (districtLayer.getLayers().length) map.fitBounds(districtLayer.getBounds());
    } catch (err) {
      if (!box.isConnected) return;
      $('#results', box).innerHTML = `<div class="banner warn">${esc(err.message)}
        <div class="btn-row mt"><button class="btn small" data-retry>Nochmal versuchen</button></div></div>`;
      $('[data-retry]', box).addEventListener('click', () => loadCity(place));
    }
    summary();
  };

  // Stadt, in der man gerade ist, direkt übernehmen und ihre Stadtteile laden
  if (!S.city) {
    navigator.geolocation?.getCurrentPosition(async (p) => {
      try {
        const place = await reverseCity({ lat: p.coords.latitude, lng: p.coords.longitude });
        const q = $('#q', box);
        if (place && q?.isConnected && !q.value && !S.city) {
          q.value = place.short;
          loadCity(place);
        }
      } catch { /* ohne Vorbelegung weiter */ }
    }, () => {}, { timeout: 10000, maximumAge: 600000 });
  }

  // vorhandenen Zustand wiederherstellen
  drawLevels();
  drawDistricts();
  if (districtLayer.getLayers().length) map.fitBounds(districtLayer.getBounds());
  else if (S.city) { const [s, n, w, e] = S.city.bbox; map.fitBounds([[s, w], [n, e]]); }
  else locateRoughly(map);
  summary();

  $('#f-search', box).addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#q', box).value.trim();
    if (!q) return;
    busy(e.submitter, async () => {
      const res = await searchPlaces(q);
      if (!res.length) { $('#results', box).innerHTML = '<div class="banner warn">Nichts gefunden.</div>'; return; }
      $('#results', box).innerHTML = res.map((r, i) =>
        `<button class="q" data-res="${i}"><strong>${esc(r.short)}</strong><br><span class="small muted">${esc(r.name)}</span></button>`).join('');
      $('#results', box).onclick = (ev) => {
        const b = ev.target.closest('[data-res]');
        if (b) loadCity(res[+b.dataset.res]);
      };
    });
  });

  $('#levels', box).addEventListener('click', (e) => {
    const b = e.target.closest('[data-level]');
    if (!b) return;
    S.level = b.dataset.level;
    S.selected = new Set();
    drawLevels(); drawDistricts(); summary();
  });

  $('[data-back]', box).addEventListener('click', () => go(0));
  $('[data-next]', box).addEventListener('click', () => go(2));
}

// ------------------------------------------------------------- Schritt 3: eigene Gebiete

function stepDraw(box) {
  const hasPM = !!(window.L && L.PM);
  box.innerHTML = `
    <div class="card">
      <h3>Eigene Gebiete zeichnen</h3>
      <p class="muted small">Optional: Ergänze oder verkleinere das Spielfeld mit eigenen Gebieten. Tippe dazu erst auf einen der Knöpfe,
        dann Eckpunkte auf die Karte. Zum Abschließen tippst du wieder auf den ersten Punkt.
        Die ausgewählten Stadtteile sind hier nur zur Orientierung zu sehen; ändern kannst du sie einen Schritt zurück.</p>
      ${hasPM ? `
      <div class="small" style="font-weight:700;margin-top:10px">Spielfeld ändern</div>
      <div class="map-tools">
        <button class="btn small" data-draw="add">+ Gebiet zum Spielfeld hinzufügen</button>
        <button class="btn small red" data-draw="cut">− Gebiet aus dem Spielfeld herausnehmen</button>
      </div>
      <div class="small" style="font-weight:700">Gezeichnete Gebiete bearbeiten</div>
      <div class="map-tools">
        <button class="btn small ghost" data-tool="edit">Eckpunkte verschieben</button>
        <button class="btn small ghost" data-tool="remove">Gezeichnetes Gebiet verwerfen</button>
      </div>
      <p class="muted small">„Verwerfen“ löscht nur deine Zeichnung wieder, egal ob sie etwas hinzugefügt oder herausgenommen hat.</p>`
      : '<div class="banner warn">Das Zeichenwerkzeug konnte nicht geladen werden.</div>'}
      <div id="drawhint"></div>
    </div>
    <div class="map" id="fmap"></div>
    <div id="summary" class="banner info mt"></div>
    <div class="btn-row mt">
      <button class="btn ghost" data-back>Zurück: Stadtteile</button>
      <button class="btn" data-next>Weiter</button>
    </div>`;

  map = createMap($('#fmap', box));
  // Stadtteile nur als Vorschau – nicht anklickbar, damit Klicks beim Zeichnen ankommen
  const preview = L.featureGroup().addTo(map);
  for (const d of (S.levels[S.level] || []).filter((x) => S.selected.has(x.id))) {
    L.geoJSON(d.geometry, { style: { ...STYLE_SELECTED, fillOpacity: 0.2 }, interactive: false, pmIgnore: true }).addTo(preview);
  }
  const drawnLayer = L.featureGroup().addTo(map);
  const styleDrawn = (kind) => kind === 'cut'
    ? { color: '#d63a3a', weight: 2, fillColor: '#d63a3a', fillOpacity: 0.3, dashArray: '6 4' }
    : { color: '#1d2b53', weight: 2, fillColor: '#ff6b35', fillOpacity: 0.35 };

  const summary = () => {
    const a = drawnLayer.getLayers().filter((l) => l.hsKind !== 'cut').length;
    const c = drawnLayer.getLayers().filter((l) => l.hsKind === 'cut').length;
    const parts = [selectionText()];
    if (a) parts.push(`${a} ${a === 1 ? 'Gebiet' : 'Gebiete'} hinzugefügt`);
    if (c) parts.push(`${c} ${c === 1 ? 'Gebiet' : 'Gebiete'} herausgenommen`);
    $('#summary', box).textContent = parts.join(' · ');
  };

  for (const [kind, list] of [['add', S.adds], ['cut', S.cuts]]) {
    for (const g of list) {
      L.geoJSON(g, { style: styleDrawn(kind) }).eachLayer((l) => { l.hsKind = kind; drawnLayer.addLayer(l); });
    }
  }
  const all = L.featureGroup([...preview.getLayers(), ...drawnLayer.getLayers()]);
  if (all.getLayers().length) map.fitBounds(all.getBounds());
  else if (S.city) { const [s, n, w, e] = S.city.bbox; map.fitBounds([[s, w], [n, e]]); }
  else locateRoughly(map);
  summary();

  if (hasPM) {
    let drawKind = 'add';
    map.on('pm:create', (e) => {
      e.layer.hsKind = drawKind;
      e.layer.setStyle(styleDrawn(drawKind));
      map.removeLayer(e.layer);
      drawnLayer.addLayer(e.layer);
      $('#drawhint', box).innerHTML = '';
      summary();
    });
    map.on('pm:remove', (e) => { drawnLayer.removeLayer(e.layer); summary(); });
    box.addEventListener('click', (e) => {
      const d = e.target.closest('[data-draw]');
      const t = e.target.closest('[data-tool]');
      if (d) {
        drawKind = d.dataset.draw;
        if (map.pm.globalEditModeEnabled()) map.pm.disableGlobalEditMode();
        if (map.pm.globalRemovalModeEnabled()) map.pm.disableGlobalRemovalMode();
        map.pm.enableDraw('Polygon', {
          snappable: true, allowSelfIntersection: false,
          templineStyle: styleDrawn(drawKind), hintlineStyle: { ...styleDrawn(drawKind), dashArray: '4 4' },
          pathOptions: styleDrawn(drawKind),
        });
        $('#drawhint', box).innerHTML = `<div class="banner ${drawKind === 'cut' ? 'danger' : 'info'}">
          ${drawKind === 'cut' ? 'Gebiet aus dem Spielfeld herausnehmen' : 'Gebiet zum Spielfeld hinzufügen'}: Eckpunkte setzen, zum Abschließen auf den ersten Punkt tippen.
          <button class="btn small ghost mt" data-stopdraw>Abbrechen</button></div>`;
        $('#fmap', box).scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      if (e.target.closest('[data-stopdraw]')) { map.pm.disableDraw(); $('#drawhint', box).innerHTML = ''; }
      if (t?.dataset.tool === 'edit') {
        map.pm.disableDraw();
        if (map.pm.globalRemovalModeEnabled()) map.pm.disableGlobalRemovalMode();
        map.pm.toggleGlobalEditMode();
        $('#drawhint', box).innerHTML = map.pm.globalEditModeEnabled()
          ? '<div class="banner info">Ziehe die Eckpunkte deiner gezeichneten Gebiete. Tippe nochmal auf „Eckpunkte verschieben“, wenn du fertig bist.</div>' : '';
      }
      if (t?.dataset.tool === 'remove') {
        map.pm.disableDraw();
        if (map.pm.globalEditModeEnabled()) map.pm.disableGlobalEditMode();
        map.pm.toggleGlobalRemovalMode();
        $('#drawhint', box).innerHTML = map.pm.globalRemovalModeEnabled()
          ? '<div class="banner danger">Tippe auf ein gezeichnetes Gebiet, um die Zeichnung zu verwerfen. Das Spielfeld selbst bleibt sonst unverändert.</div>' : '';
      }
    });
  }

  const save = () => {
    if (hasPM) {
      map.pm.disableDraw();
      if (map.pm.globalEditModeEnabled()) map.pm.disableGlobalEditMode();
      if (map.pm.globalRemovalModeEnabled()) map.pm.disableGlobalRemovalMode();
    }
    S.adds = []; S.cuts = [];
    drawnLayer.eachLayer((l) => (l.hsKind === 'cut' ? S.cuts : S.adds).push(l.toGeoJSON(6).geometry));
  };
  $('[data-back]', box).addEventListener('click', () => { save(); go(1); });
  $('[data-next]', box).addEventListener('click', () => {
    save();
    if (!S.selected.size && !S.adds.length) { toast('Wähle Stadtteile aus (einen Schritt zurück) oder füge ein gezeichnetes Gebiet hinzu.', 'error'); return; }
    go(3);
  });
}

function locateRoughly(m) {
  navigator.geolocation?.getCurrentPosition((p) => m.setView([p.coords.latitude, p.coords.longitude], 13), () => {}, { timeout: 8000, maximumAge: 600000 });
}

/** Vorschau des Spielfelds (ohne echte Vereinigung – die macht der Server) */
function previewLayers() {
  const g = L.featureGroup();
  for (const d of (S.levels[S.level] || []).filter((x) => S.selected.has(x.id))) {
    L.geoJSON(d.geometry, { style: { ...FIELD_STYLE, weight: 1, fillOpacity: 0.18 }, interactive: false, pmIgnore: true }).addTo(g);
  }
  for (const a of S.adds) L.geoJSON(a, { style: { ...FIELD_STYLE, weight: 1, fillOpacity: 0.18 }, interactive: false, pmIgnore: true }).addTo(g);
  for (const c of S.cuts) L.geoJSON(c, { style: { color: '#d63a3a', weight: 1, fillColor: '#d63a3a', fillOpacity: 0.35 }, interactive: false, pmIgnore: true }).addTo(g);
  return g;
}

// ------------------------------------------------------------- Schritt 3: Orte

function step2(box) {
  let placing = null;
  box.innerHTML = `
    <div class="card">
      <h3>Orte für die Relativ-Fragen</h3>
      <p class="muted small">Bis zu 4 bekannte Orte, z. B. Bahnhof, Rathaus, Schule. Die Seeker können dann fragen:
        „Sind wir näher an … als ihr?“ Name eingeben und dann auf die Karte tippen.</p>
      <div id="places"></div>
    </div>
    <div class="map" id="pmap"></div>
    <div class="card mt">
      <label class="field"><span>Sehenswürdigkeit für die Blockade „Zeichnen“</span>
        <input type="text" id="landmark" maxlength="80" value="${esc(S.landmark)}" placeholder="z. B. das Schloss">
        <small>Diese Sehenswürdigkeit müssen die Seeker zeichnen.</small></label>
    </div>
    <div class="btn-row">
      <button class="btn ghost" data-back>Zurück</button>
      <button class="btn" data-next>Weiter</button>
    </div>`;

  map = createMap($('#pmap', box));
  const prev = previewLayers().addTo(map);
  if (prev.getLayers().length) map.fitBounds(prev.getBounds());
  const markers = [];

  const drawPlaces = () => {
    $('#places', box).innerHTML = S.places.map((p, i) => `
      <div class="row" style="margin-bottom:8px">
        <span class="avatar" style="background:${p.lat != null ? 'var(--green)' : 'var(--line)'}">${i + 1}</span>
        <input type="text" class="grow" data-pname="${i}" maxlength="40" placeholder="Ort ${i + 1}" value="${esc(p.name)}">
        <button class="btn small ${placing === i ? '' : 'ghost'}" data-place="${i}">${placing === i ? 'Tippe auf Karte' : (p.lat != null ? 'Versetzen' : 'Auf Karte')}</button>
      </div>`).join('');
    markers.forEach((m) => m.remove());
    markers.length = 0;
    S.places.forEach((p, i) => {
      if (p.lat != null) markers.push(L.marker([p.lat, p.lng], { icon: placeIcon(p.name || `Ort ${i + 1}`), interactive: false }).addTo(map));
    });
  };
  drawPlaces();

  box.addEventListener('input', (e) => {
    const i = e.target.dataset.pname;
    if (i !== undefined) S.places[+i].name = e.target.value;
  });
  box.addEventListener('change', (e) => { if (e.target.dataset.pname !== undefined) drawPlaces(); });
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-place]');
    if (!b) return;
    placing = placing === +b.dataset.place ? null : +b.dataset.place;
    drawPlaces();
    if (placing !== null) $('#pmap', box).scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  map.on('click', (e) => {
    if (placing === null) return;
    S.places[placing].lat = +e.latlng.lat.toFixed(6);
    S.places[placing].lng = +e.latlng.lng.toFixed(6);
    placing = null;
    drawPlaces();
  });

  const save = () => { S.landmark = $('#landmark', box).value.trim(); };
  $('[data-back]', box).addEventListener('click', () => { save(); go(2); });
  $('[data-next]', box).addEventListener('click', () => {
    save();
    const bad = S.places.find((p) => (p.name.trim() && p.lat == null) || (!p.name.trim() && p.lat != null));
    if (bad) { toast('Jeder Ort braucht einen Namen und einen Punkt auf der Karte.', 'error'); return; }
    go(4);
  });
}

// ------------------------------------------------------------- Schritt 4: Regeln

function step3(box) {
  const slider = (id, label, min, max, step, val, unit, help) => `
    <label class="field"><span>${label}</span>
      <div class="range-row"><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}">
      <output id="${id}-o">${val} ${unit}</output></div>
      ${help ? `<small>${help}</small>` : ''}</label>`;
  box.innerHTML = `
    <div class="card">
      ${slider('hide', 'Versteckzeit', 5, 60, 1, S.hide, 'min', 'So lange haben die Hider Zeit, sich zu verstecken.')}
      ${slider('radius', 'Zielzone', 50, 1000, 10, S.radius, 'm', 'Umkreis um das Versteck. Betritt ein Seeker-Team die Zone, beginnt das Endspiel.')}
      ${slider('answer', 'Antwortzeit', 2, 10, 1, S.answer, 'min', 'So lange haben die Hider Zeit, eine Frage zu beantworten.')}
    </div>
    <div class="card flat small">
      <strong>${esc(S.title)}</strong><br>
      ${S.min}–${S.max} Spieler · Spielleiter: ${esc(S.name)}${S.plays ? ' (spielt mit)' : ' (schaut zu)'}<br>
      ${S.places.filter((p) => p.lat != null).length} Orte · ${S.landmark ? 'Zeichnen: ' + esc(S.landmark) : 'keine Sehenswürdigkeit'}
    </div>
    <div class="btn-row">
      <button class="btn ghost" data-back>Zurück</button>
      <button class="btn green big" data-create>Spiel anlegen</button>
    </div>`;
  for (const [id, unit] of [['hide', 'min'], ['radius', 'm'], ['answer', 'min']]) {
    const inp = $('#' + id, box);
    inp.addEventListener('input', () => { $('#' + id + '-o', box).textContent = `${inp.value} ${unit}`; S[id] = +inp.value; });
  }
  $('[data-back]', box).addEventListener('click', () => go(3));
  $('[data-create]', box).addEventListener('click', (e) => busy(e.currentTarget, createGame));
}

function round6(geom) {
  const r = (c) => (typeof c[0] === 'number' ? [+c[0].toFixed(6), +c[1].toFixed(6)] : c.map(r));
  return { type: geom.type, coordinates: r(geom.coordinates) };
}

function bboxOf(geom) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (c) => {
    if (typeof c[0] === 'number') { b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]); b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]); } else c.forEach(walk);
  };
  walk(geom.coordinates);
  return b;
}
const overlaps = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

async function createGame() {
  const all = S.levels[S.level] || [];
  const chosen = all.filter((d) => S.selected.has(d.id));
  // Stadtteile mitschicken, die das Spielfeld berühren könnten (für „Sind wir im selben Stadtteil?“)
  const addBoxes = S.adds.map(bboxOf);
  const districts = all.filter((d) => S.selected.has(d.id) || addBoxes.some((bb) => overlaps(bb, bboxOf(d.geometry))));

  const toIso = (v) => (v ? new Date(v).toISOString() : null);
  const p = {
    title: S.title, name: S.name, plays: S.plays,
    earliest_at: toIso(S.earliest), latest_at: toIso(S.latest),
    min_players: S.min, max_players: S.max,
    hide_minutes: S.hide, zone_radius_m: S.radius, answer_minutes: S.answer,
    places: S.places.filter((x) => x.lat != null && x.name.trim()).map((x) => ({ name: x.name.trim(), lat: x.lat, lng: x.lng })),
    landmark: S.landmark,
    add: [...chosen.map((d) => round6(d.geometry)), ...S.adds.map(round6)],
    cut: S.cuts.map(round6),
    districts: districts.map((d) => ({ name: d.name, geometry: round6(d.geometry) })),
  };
  try {
    const id = await rpc('create_game', { p });
    store.set('name', S.name);
    store.set('lastGame', id);
    location.hash = '#/g/' + id;
  } catch (e) { showError(e); }
}
