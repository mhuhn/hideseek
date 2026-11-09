// Standort: beobachten, regelmäßig an den Server schicken, Geometrie-Helfer

let watchId = null;
let last = null;          // {lat, lng, acc, t}
let lastError = null;
const listeners = new Set();
let uploader = null;
let uploadTimer = null;
let lastUploadAt = 0;
let lastUploadPos = null;

export function onPosition(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function getPos() { return last; }
export function getGeoError() { return lastError; }

export function startGeo() {
  if (watchId !== null || !('geolocation' in navigator)) return;
  watchId = navigator.geolocation.watchPosition(
    (p) => {
      last = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, t: Date.now() };
      lastError = null;
      listeners.forEach((f) => f(last));
      maybeUpload(false);
    },
    (err) => { lastError = err; listeners.forEach((f) => f(null, err)); },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 },
  );
}

export function stopGeo() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  setUploader(null);
}

/** fn(pos) wird höchstens alle 10 s aufgerufen, bei Bewegung > 25 m sofort (max. alle 4 s) */
export function setUploader(fn) {
  uploader = fn;
  if (uploadTimer) clearInterval(uploadTimer);
  uploadTimer = fn ? setInterval(() => maybeUpload(true), 10000) : null;
  if (fn) maybeUpload(true);
}

function maybeUpload(force) {
  if (!uploader || !last) return;
  const now = Date.now();
  const moved = lastUploadPos ? distance(lastUploadPos, last) : Infinity;
  if (force ? now - lastUploadAt < 9000 : !(moved > 25 && now - lastUploadAt > 4000)) return;
  lastUploadAt = now;
  lastUploadPos = last;
  Promise.resolve(uploader(last)).catch(() => {});
}

/** Aktuelle Position; nimmt die letzte, wenn sie jünger als maxAge ist. */
export function freshPos(maxAge = 20000) {
  if (last && Date.now() - last.t < maxAge) return Promise.resolve(last);
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) { reject(new Error('Dieses Gerät kann keinen Standort bestimmen.')); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => {
        last = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, t: Date.now() };
        resolve(last);
      },
      (err) => reject(new Error(geoErrorText(err))),
      { enableHighAccuracy: true, maximumAge: maxAge, timeout: 20000 },
    );
  });
}

export function geoErrorText(err) {
  if (!err) return '';
  if (err.code === 1) return 'Die App darf deinen Standort nicht verwenden. Bitte erlaube den Standortzugriff in den Einstellungen.';
  if (err.code === 3) return 'Der Standort konnte nicht rechtzeitig bestimmt werden.';
  return 'Der Standort ist gerade nicht verfügbar.';
}

// ---------------------------------------------------------------- Geometrie

export function distance(a, b) {
  const R = 6371008.8;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function inRing(pt, ring) {   // ring: [[lng, lat], ...]
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
    if ((yi > pt.lat) !== (yj > pt.lat) && pt.lng < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Punkt in (Multi)Polygon-GeoJSON-Geometrie? */
export function inGeometry(pt, geom) {
  if (!geom) return true;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  return polys.some((poly) => poly.length && inRing(pt, poly[0]) && !poly.slice(1).some((hole) => inRing(pt, hole)));
}

/** Abstand Punkt–Linienzug in Metern (lokal eben gerechnet, für kurze Strecken genau genug) */
export function distToLine(pt, line) {   // line: [{lat, lng}]
  const kx = 111320 * Math.cos(pt.lat * Math.PI / 180);
  const ky = 110540;
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const ax = (line[i - 1].lng - pt.lng) * kx; const ay = (line[i - 1].lat - pt.lat) * ky;
    const bx = (line[i].lng - pt.lng) * kx; const by = (line[i].lat - pt.lat) * ky;
    const dx = bx - ax; const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const px = ax + t * dx; const py = ay + t * dy;
    best = Math.min(best, Math.hypot(px, py));
  }
  return best;
}
