// Modello digitale del terreno da tile "Terrarium" (AWS Open Data, gratuito)
import { DEM_URL } from './config.js';
import { lon2px, lat2px, px2lon, px2lat, metersPerPixel, bboxAround } from './geo.js';

async function fetchTile(z, x, y) {
  const res = await fetch(DEM_URL(z, x, y), { mode: 'cors' });
  if (!res.ok) throw new Error(`DEM ${z}/${x}/${y}: ${res.status}`);
  const bmp = await createImageBitmap(await res.blob());
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(256, 256) : Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const d = ctx.getImageData(0, 0, 256, 256).data;
  const out = new Float32Array(256 * 256);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
  return out;
}

async function pool(items, n, fn) {
  const res = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; res[k] = await fn(items[k], k); }
  }));
  return res;
}

export class Mosaic {
  constructor(z, tx0, ty0, nx, ny, data) {
    Object.assign(this, { z, tx0, ty0, nx, ny, data, W: nx * 256, H: ny * 256 });
    this.ox = tx0 * 256; this.oy = ty0 * 256;
  }
  // pixel locali <-> lat/lon
  toLatLon(px, py) { return { lat: px2lat(this.oy + py, this.z), lon: px2lon(this.ox + px, this.z) }; }
  toPx(lat, lon) { return { x: lon2px(lon, this.z) - this.ox, y: lat2px(lat, this.z) - this.oy }; }
  at(x, y) {
    x = Math.max(0, Math.min(this.W - 1, x | 0)); y = Math.max(0, Math.min(this.H - 1, y | 0));
    return this.data[y * this.W + x];
  }
  elevation(lat, lon) {
    const p = this.toPx(lat, lon);
    const x0 = Math.floor(p.x), y0 = Math.floor(p.y), fx = p.x - x0, fy = p.y - y0;
    const a = this.at(x0, y0), b = this.at(x0 + 1, y0), c = this.at(x0, y0 + 1), d = this.at(x0 + 1, y0 + 1);
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
  }
  // Pendenza (gradi) ed esposizione (gradi da Nord, verso cui "guarda" il versante) — metodo di Horn
  // step = distanza in pixel tra i campioni (riduce il rumore alle risoluzioni alte)
  slopeAspectPx(x, y, step = 1) {
    const s = step;
    const a = this.at(x - s, y - s), b = this.at(x, y - s), c = this.at(x + s, y - s);
    const d = this.at(x - s, y), f = this.at(x + s, y);
    const g = this.at(x - s, y + s), h = this.at(x, y + s), i = this.at(x + s, y + s);
    const lat = this.toLatLon(x, y).lat;
    const m = metersPerPixel(lat, this.z) * s;
    const dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * m);
    const dzdyS = ((g + 2 * h + i) - (a + 2 * b + c)) / (8 * m);
    const slope = (Math.atan(Math.hypot(dzdx, dzdyS)) * 180) / Math.PI;
    let aspect = (Math.atan2(-dzdx, dzdyS) * 180) / Math.PI;
    if (aspect < 0) aspect += 360;
    return { slope, aspect };
  }
  terrainAt(lat, lon, step = 1) {
    const p = this.toPx(lat, lon);
    return { elevation: this.elevation(lat, lon), ...this.slopeAspectPx(Math.round(p.x), Math.round(p.y), step) };
  }
}

// Sceglie lo zoom più dettagliato che copre il raggio con al massimo maxTiles tile
export async function loadMosaic(lat, lon, radiusKm, { maxTiles = 64, maxZoom = 13, onProgress } = {}) {
  const bb = bboxAround(lat, lon, radiusKm * 1.05);
  let z = maxZoom, tx0, ty0, tx1, ty1;
  for (; z >= 7; z--) {
    tx0 = Math.floor(lon2px(bb.west, z) / 256); tx1 = Math.floor(lon2px(bb.east, z) / 256);
    ty0 = Math.floor(lat2px(bb.north, z) / 256); ty1 = Math.floor(lat2px(bb.south, z) / 256);
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= maxTiles) break;
  }
  const nx = tx1 - tx0 + 1, ny = ty1 - ty0 + 1;
  const W = nx * 256, H = ny * 256;
  const data = new Float32Array(W * H);
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push([tx, ty]);
  let done = 0;
  await pool(jobs, 6, async ([tx, ty]) => {
    let tile;
    try { tile = await fetchTile(z, tx, ty); } catch { tile = new Float32Array(256 * 256).fill(-9999); }
    const ox = (tx - tx0) * 256, oy = (ty - ty0) * 256;
    for (let r = 0; r < 256; r++) data.set(tile.subarray(r * 256, r * 256 + 256), (oy + r) * W + ox);
    onProgress?.(++done / jobs.length);
  });
  return new Mosaic(z, tx0, ty0, nx, ny, data);
}

// Terreno per un singolo punto (quota, pendenza, esposizione) a zoom 13 (~15 m/pixel in Toscana)
export async function terrainAtPoint(lat, lon) {
  const m = await loadMosaic(lat, lon, 0.3, { maxTiles: 4, maxZoom: 13 });
  return m.terrainAt(lat, lon, 2);
}
