// OpenStreetMap: Ortssuche (Nominatim), Stadtteilgrenzen und Straßen (Overpass)
import { distToLine } from './geo.js';

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

async function overpass(query) {
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error('Overpass ' + res.status);
      return await res.json();
    } catch (e) { lastErr = e; }
  }
  throw new Error('OpenStreetMap antwortet gerade nicht. Bitte später noch einmal versuchen. (' + lastErr?.message + ')');
}

export async function searchPlaces(q) {
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=de&q=' + encodeURIComponent(q);
  const res = await fetch(url);
  if (!res.ok) throw new Error('Die Ortssuche antwortet gerade nicht.');
  const list = await res.json();
  return list.map((r) => ({
    name: r.display_name,
    short: r.name || r.display_name.split(',')[0],
    type: r.osm_type, id: r.osm_id,
    lat: +r.lat, lng: +r.lon,
    bbox: r.boundingbox.map(Number),   // [south, north, west, east]
  }));
}

// ------------------------------------------------------------- Stadtteile

const key = (p) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;

/** Wege (Arrays von {lat, lon}) zu geschlossenen Ringen zusammensetzen */
function stitch(ways) {
  const pool = ways.filter((w) => w && w.length > 1).map((w) => w.slice());
  const rings = [];
  while (pool.length) {
    let ring = pool.pop();
    let guard = 0;
    while (key(ring[0]) !== key(ring[ring.length - 1]) && guard++ < 10000) {
      const end = key(ring[ring.length - 1]);
      const i = pool.findIndex((w) => key(w[0]) === end || key(w[w.length - 1]) === end);
      if (i < 0) break;
      const w = pool.splice(i, 1)[0];
      ring = ring.concat((key(w[0]) === end ? w : w.slice().reverse()).slice(1));
    }
    if (ring.length >= 4 && key(ring[0]) === key(ring[ring.length - 1])) {
      rings.push(ring.map((p) => [p.lon, p.lat]));
    }
  }
  return rings;
}

function ringContains(ring, [x, y]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function relationToGeometry(rel) {
  const ways = (role) => rel.members.filter((m) => m.type === 'way' && m.geometry && (role === 'outer' ? m.role !== 'inner' : m.role === 'inner')).map((m) => m.geometry);
  const outers = stitch(ways('outer'));
  if (!outers.length) return null;
  const polys = outers.map((r) => [r]);
  for (const inner of stitch(ways('inner'))) {
    const host = polys.find((p) => ringContains(p[0], inner[0]));
    if (host) host.push(inner);
  }
  return { type: 'MultiPolygon', coordinates: polys };
}

/**
 * Verwaltungsgrenzen unterhalb einer Stadt laden.
 * Liefert {levels: {<admin_level>: [{name, geometry}]}}
 */
export async function loadDistricts(place) {
  let scope;
  if (place.type === 'relation') {
    scope = `area(id:${3600000000 + Number(place.id)})->.a;\nrel(area.a)["boundary"="administrative"]["admin_level"~"^(7|8|9|10|11)$"];`;
  } else {
    const [s, n, w, e] = place.bbox;
    scope = `rel["boundary"="administrative"]["admin_level"~"^(9|10|11)$"](${s},${w},${n},${e});`;
  }
  const data = await overpass(`[out:json][timeout:60];\n${scope}\nout geom;`);
  const levels = {};
  for (const el of data.elements || []) {
    if (el.type !== 'relation' || (place.type === 'relation' && el.id === Number(place.id))) continue;
    const geometry = relationToGeometry(el);
    if (!geometry) continue;
    const lvl = el.tags?.admin_level || '?';
    (levels[lvl] ||= []).push({ id: el.id, name: el.tags?.name || 'Unbenannt', geometry });
  }
  for (const l of Object.values(levels)) l.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return levels;
}

// ------------------------------------------------------------- Straßen

const NOT_STREETS = 'footway|path|cycleway|steps|track|service|platform|corridor|bridleway|proposed|construction|elevator|raceway|bus_stop';

/** Nächste benannte Straße zu einem Punkt: {name, dist} oder null */
export async function nearestStreet(pt, radius = 250) {
  const q = `[out:json][timeout:20];way(around:${radius},${pt.lat},${pt.lng})["highway"]["name"]["highway"!~"^(${NOT_STREETS})$"];out tags geom;`;
  const data = await overpass(q);
  let best = null;
  for (const w of data.elements || []) {
    if (!w.geometry) continue;
    const d = distToLine(pt, w.geometry.map((p) => ({ lat: p.lat, lng: p.lon })));
    if (!best || d < best.dist) best = { name: w.tags.name, dist: d };
  }
  return best;
}

export function countLetters(name) {
  return (String(name).match(/\p{L}/gu) || []).length;
}
