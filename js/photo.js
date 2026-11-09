// Fotos: nur direkt mit der Kamera (keine Galerie), verkleinern, hochladen, anzeigen
import { sb } from './sb.js';
import { $$, openModal, esc, toast } from './ui.js';

/** Öffnet direkt die Kamera. facing: 'environment' (hinten) oder 'user' (Selfie) */
export function takePhoto(facing = 'environment') {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.setAttribute('capture', facing);
    inp.style.display = 'none';
    document.body.appendChild(inp);
    const done = (f) => { inp.remove(); resolve(f); };
    inp.addEventListener('change', () => done(inp.files?.[0] || null));
    inp.addEventListener('cancel', () => done(null));
    inp.click();
  });
}

async function shrink(file, max = 1600) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
  } catch {
    return file;   // älterer Browser: Original hochladen
  }
}

export async function uploadPhoto(gameId, file) {
  const blob = await shrink(file);
  const path = `${gameId}/${crypto.randomUUID()}.jpg`;
  const { error } = await sb.storage.from('photos').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
  if (error) throw new Error('Foto-Upload fehlgeschlagen: ' + error.message);
  return path;
}

/** Kamera öffnen und hochladen; liefert den Pfad oder null bei Abbruch */
export async function captureAndUpload(gameId, facing) {
  const file = await takePhoto(facing);
  if (!file) return null;
  toast('Foto wird hochgeladen …');
  return uploadPhoto(gameId, file);
}

const urlCache = new Map();
async function signedUrl(path) {
  const hit = urlCache.get(path);
  if (hit && hit.exp > Date.now()) return hit.url;
  const { data, error } = await sb.storage.from('photos').createSignedUrl(path, 3600);
  if (error) throw error;
  urlCache.set(path, { url: data.signedUrl, exp: Date.now() + 50 * 60 * 1000 });
  return data.signedUrl;
}

/** <img data-photo="pfad"> mit signierter URL füllen */
export function hydratePhotos(root = document) {
  for (const img of $$('img[data-photo]', root)) {
    const path = img.dataset.photo;
    const hit = urlCache.get(path);
    if (hit && hit.exp > Date.now()) { img.src = hit.url; continue; }
    signedUrl(path).then((u) => { if (img.dataset.photo === path) img.src = u; }).catch(() => {});
  }
}

export function photoTag(path, alt = 'Foto') {
  return `<img class="photo" data-photo="${esc(path)}" alt="${esc(alt)}" data-zoom>`;
}

export function zoomPhoto(src) {
  openModal(`<img src="${esc(src)}" alt="" style="width:100%;border-radius:14px;display:block">
    <button class="btn block mt" data-close>Schließen</button>`);
}

// ------------------------------------------------------------- Zeichnen

/** Zeichenfläche für die Blockade „Zeichnen“ */
export function openDrawing(title) {
  const m = openModal(`
    <h2>Zeichnen</h2>
    <p class="muted">${esc(title)}</p>
    <canvas class="draw-canvas" width="900" height="900"></canvas>
    <div class="btn-row mt">
      <button class="btn ghost" data-clear>Löschen</button>
      <button class="btn" data-share>Bild teilen</button>
    </div>
    <button class="btn ghost block mt" data-close>Fertig</button>`, { dismissable: false });
  const canvas = m.el.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const clear = () => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); };
  clear();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1d2b53'; ctx.lineWidth = 9;
  let drawing = false;
  const pt = (e) => {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height];
  };
  canvas.addEventListener('pointerdown', (e) => { drawing = true; canvas.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...pt(e)); });
  canvas.addEventListener('pointermove', (e) => { if (!drawing) return; ctx.lineTo(...pt(e)); ctx.stroke(); });
  const stop = () => { drawing = false; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  m.el.querySelector('[data-clear]').addEventListener('click', clear);
  m.el.querySelector('[data-share]').addEventListener('click', () => {
    canvas.toBlob(async (blob) => {
      const file = new File([blob], 'was-ist-das.png', { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file], text: 'Was ist das?' }); } catch { /* abgebrochen */ }
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      }
    }, 'image/png');
  });
}
