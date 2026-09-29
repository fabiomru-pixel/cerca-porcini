// Fonti esterne: bosco (Copernicus HRL Forest Type, 10 m) e aree protette (EEA – elenco ufficiale EUAP)
import { FOREST_TYPE_URL, EEA_PROTECTED_URL } from './config.js';
import { pointInPolygon, lon2px, lat2px } from './geo.js';

const HALF = 20037508.342789244;
const pxToM = (px, z) => (px * (2 * HALF)) / (256 * 2 ** z) - HALF;
const pyToM = (py, z) => HALF - (py * (2 * HALF)) / (256 * 2 ** z);

// Codici: 0 = non bosco, 1 = latifoglie, 2 = conifere
async function exportForest(x0, y0, x1, y1, w, h) {
  const p = new URLSearchParams({
    bbox: `${x0},${y0},${x1},${y1}`, bboxSR: '3857', imageSR: '3857',
    size: `${w},${h}`, format: 'png', interpolation: 'RSP_NearestNeighbor', f: 'image',
  });
  const res = await fetch(`${FOREST_TYPE_URL}?${p}`);
  if (!res.ok) throw new Error(`Carta forestale: ${res.status}`);
  const bmp = await createImageBitmap(await res.blob());
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const codes = new Uint8Array(w * h);
  for (let i = 0; i < codes.length; i++) {
    const a = d[i * 4 + 3];
    if (a < 128) continue;
    // latifoglie ~ (70,158,74), conifere ~ (28,92,36)
    codes[i] = d[i * 4 + 1] > 125 ? 1 : 2;
  }
  return codes;
}

// Raster forestale allineato ai pixel globali Web Mercator [px0,px1) x [py0,py1) a zoom z
export async function forestRaster(z, px0, py0, px1, py1, w, h) {
  const codes = await exportForest(pxToM(px0, z), pyToM(py1, z), pxToM(px1, z), pyToM(py0, z), w, h);
  return { w, h, codes };
}

// Intorno di un punto (~r metri): frazione di bosco, tipo dominante, margine
export async function forestPatch(lat, lon, r = 150, n = 30) {
  const z = 18;
  const mercRes = (2 * HALF) / (256 * 2 ** z);
  const cx = lon2px(lon, z), cy = lat2px(lat, z);
  const d = r / (mercRes * Math.cos((lat * Math.PI) / 180)); // metri reali -> pixel
  const { codes } = await forestRaster(z, cx - d, cy - d, cx + d, cy + d, n, n);
  let broad = 0, conif = 0, centerCode = codes[Math.floor(n / 2) * n + Math.floor(n / 2)];
  for (const c of codes) { if (c === 1) broad++; else if (c === 2) conif++; }
  const frac = (broad + conif) / codes.length;
  return { frac, broad: broad / codes.length, conif: conif / codes.length, center: centerCode, type: broad >= conif ? 'latifoglie' : 'conifere' };
}

// Aree protette nazionali/regionali nel riquadro (poligoni semplificati)
export async function fetchProtected(bb) {
  const feats = [];
  let offset = 0;
  for (let page = 0; page < 10; page++) {
    const p = new URLSearchParams({
      where: "countryCode='IT'",
      geometry: `${bb.west},${bb.south},${bb.east},${bb.north}`,
      geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
      outFields: 'siteName,iucnCategory,nationalId', outSR: '4326',
      maxAllowableOffset: '0.0008', resultOffset: String(offset), resultRecordCount: '200', f: 'geojson',
    });
    const res = await fetch(`${EEA_PROTECTED_URL}?${p}`);
    if (!res.ok) throw new Error(`Aree protette: ${res.status}`);
    const j = await res.json();
    feats.push(...(j.features || []));
    if (!j.exceededTransferLimit && !(j.properties && j.properties.exceededTransferLimit)) break;
    offset += 200;
  }
  return { type: 'FeatureCollection', features: feats };
}

export function protectedAt(fc, lat, lon) {
  if (!fc) return null;
  for (const f of fc.features) {
    const g = f.geometry; if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const rings of polys) {
      if (pointInPolygon(lon, lat, rings)) {
        const cat = f.properties.iucnCategory || '';
        return { name: f.properties.siteName, code: f.properties.nationalId, strict: /^I[ab]$/i.test(cat), category: cat };
      }
    }
  }
  return null;
}
