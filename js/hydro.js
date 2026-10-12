// Fossi, torrenti e impluvi ricavati dall'altimetria (nessuna fonte esterna).
// Dove l'acqua si raccoglie scendendo dai versanti si forma un microclima umido: nei periodi secchi,
// con aria umida e senza vento, lì i porcini nascono anche quando il resto del bosco è asciutto.
//
// Metodo: griglia di ~30 m, "priority flood" (riempie le conche e dà a ogni cella la direzione in cui
// scende l'acqua), area drenata a monte di ogni cella, corso d'acqua dove il bacino a monte supera ~15 ha.
// Per ogni cella: distanza lungo la discesa fino al corso d'acqua e dislivello sopra di esso.
import { metersPerPixel } from './geo.js';

const CHANNEL_M2 = 150000; // 15 ettari di bacino a monte = fosso/torrente
const NODATA = -500;

// coda di priorità minima su (quota, indice cella)
class Heap {
  constructor(n) { this.k = new Float64Array(n); this.v = new Int32Array(n); this.n = 0; }
  push(key, val) {
    let i = this.n++;
    const k = this.k, v = this.v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const top = v[0];
    const lastK = k[--this.n], lastV = v[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && k[c + 1] < k[c]) c++;
      if (k[c] >= lastK) break;
      k[i] = k[c]; v[i] = v[c]; i = c;
    }
    k[i] = lastK; v[i] = lastV;
    return top;
  }
}

const ramp = (x, a, b) => Math.max(0, Math.min(1, (x - a) / (b - a)));

// Quanto un punto è "zona umida": 1 entro 40 m e 8 m sopra un corso d'acqua, 0 oltre 120 m o 25 m di dislivello.
// (Con soglie 200 m / 40 m risultava "umido" il 21% del terreno in Appennino: i fossi sono fitti.)
export function wetFactor(distM, handM) {
  if (distM == null) return 0;
  return Math.min(1 - ramp(distM, 40, 120), 1 - ramp(handM, 8, 25));
}

export function wetness(mosaic, targetM = 30) {
  const midLat = mosaic.toLatLon(0, mosaic.H / 2).lat;
  const mpp = metersPerPixel(midLat, mosaic.z);
  const k = Math.max(1, Math.round(targetM / mpp));
  const gw = Math.ceil(mosaic.W / k), gh = Math.ceil(mosaic.H / k);
  const n = gw * gh;
  const cell = mpp * k;
  const elev = new Float32Array(n);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      let s = 0, c = 0;
      for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) {
        const v = mosaic.at(x * k + dx, y * k + dy);
        if (v > NODATA) { s += v; c++; }
      }
      elev[y * gw + x] = c ? s / c : NODATA;
    }
  }

  // priority flood dai bordi (e dai buchi nei dati): ogni cella riceve come "valle" la cella da cui è stata raggiunta
  const recv = new Int32Array(n).fill(-1);
  const order = new Int32Array(n);
  const seen = new Uint8Array(n);
  const heap = new Heap(n);
  for (let i = 0; i < n; i++) {
    const x = i % gw, y = (i / gw) | 0;
    if (x === 0 || y === 0 || x === gw - 1 || y === gh - 1 || elev[i] <= NODATA) { heap.push(elev[i], i); seen[i] = 1; }
  }
  const DX = [-1, 0, 1, -1, 1, -1, 0, 1], DY = [-1, -1, -1, 0, 0, 1, 1, 1];
  let no = 0;
  while (heap.n) {
    const i = heap.pop();
    order[no++] = i;
    const x = i % gw, y = (i / gw) | 0;
    for (let d = 0; d < 8; d++) {
      const xx = x + DX[d], yy = y + DY[d];
      if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
      const j = yy * gw + xx;
      if (seen[j]) continue;
      seen[j] = 1;
      recv[j] = i;
      heap.push(Math.max(elev[j], elev[i]), j); // conca riempita fino al bordo
    }
  }

  // area drenata: dalle celle più alte verso valle
  const acc = new Float32Array(n).fill(1);
  for (let t = no - 1; t >= 0; t--) { const i = order[t]; if (recv[i] >= 0) acc[recv[i]] += acc[i]; }
  const thr = CHANNEL_M2 / (cell * cell);

  // dal basso verso l'alto: ogni cella eredita il corso d'acqua in cui scarica, distanza e dislivello
  const dist = new Float32Array(n).fill(-1);
  const hand = new Float32Array(n);
  const chE = new Float32Array(n); // quota del corso d'acqua in cui la cella scarica
  for (let t = 0; t < no; t++) {
    const i = order[t];
    if (elev[i] <= NODATA) continue;
    if (acc[i] >= thr) { dist[i] = 0; hand[i] = 0; chE[i] = elev[i]; continue; }
    const r = recv[i];
    if (r < 0 || dist[r] < 0) continue;
    const x = i % gw, y = (i / gw) | 0, rx = r % gw, ry = (r / gw) | 0;
    dist[i] = dist[r] + (x !== rx && y !== ry ? cell * Math.SQRT2 : cell);
    chE[i] = chE[r];
    hand[i] = Math.max(0, elev[i] - chE[i]);
  }

  return {
    cell,
    at(lat, lon) {
      const p = mosaic.toPx(lat, lon);
      const x = Math.floor(p.x / k), y = Math.floor(p.y / k);
      if (x < 0 || y < 0 || x >= gw || y >= gh) return { m: 0, distM: null, hand: null };
      const i = y * gw + x;
      if (dist[i] < 0) return { m: 0, distM: null, hand: null };
      return { m: wetFactor(dist[i], hand[i]), distM: Math.round(dist[i]), hand: Math.round(hand[i]) };
    },
  };
}
