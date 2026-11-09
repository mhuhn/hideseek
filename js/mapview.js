// Leaflet-Helfer
/* global L */
import { esc } from './ui.js';

export const FIELD_STYLE = { color: '#ff6b35', weight: 3, fillColor: '#ff6b35', fillOpacity: 0.08 };

export function createMap(el, opts = {}) {
  const map = L.map(el, { zoomControl: true, attributionControl: true, ...opts });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  map.setView([51.16, 10.45], 6);   // Deutschland, bis etwas Besseres kommt
  return map;
}

export function fieldLayer(geojson) {
  return L.geoJSON(geojson, { style: FIELD_STYLE, interactive: false });
}

export function dotIcon(cls = 'pos-dot') {
  return L.divIcon({ className: '', html: `<div class="${cls}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
}

export function placeIcon(label) {
  return L.divIcon({ className: '', html: `<span class="place-pin">${esc(label)}</span>`, iconSize: [0, 0] });
}

/** Marker-Verwaltung: setMarkers(key -> {lat,lng,icon,label}) */
export function markerSet(map) {
  const markers = new Map();
  return (items) => {
    const keep = new Set();
    for (const [k, it] of Object.entries(items)) {
      if (it?.lat == null) continue;
      keep.add(k);
      let m = markers.get(k);
      if (!m) {
        m = L.marker([it.lat, it.lng], { icon: it.icon, interactive: !!it.label, keyboard: false }).addTo(map);
        if (it.label) m.bindTooltip(esc(it.label), { permanent: !!it.permanent, direction: 'top', offset: [0, -10], className: 'map-label' });
        markers.set(k, m);
      } else {
        m.setLatLng([it.lat, it.lng]);
      }
    }
    for (const [k, m] of markers) if (!keep.has(k)) { m.remove(); markers.delete(k); }
  };
}
