// Analisi completa: meteo + altimetria + bosco + regole -> mappa di idoneità e spot consigliati
import { GROUPS, FORESTS, SPECIES } from './config.js';
import { loadMosaic, terrainAtPoint } from './dem.js';
import { fetchDaily } from './weather.js';
import { forestRaster, forestPatch, fetchProtected, protectedAt } from './sources.js';
import { distKm, bboxAround, aspectLabel, metersPerPixel, ASPECT_DEG, angDiff } from './geo.js';
import { contourLines } from './contours.js';
import { climateFor, tempClass, regimeOf } from './climate.js';
import { placeIdealDays, placeSummary, TIMER_CENTER } from './finds.js';
import {
  activeGroups, summarize, targetBand, evalPlace, evalTiming, bestDates, daysBetween, cellForestKey, finalScore,
} from './engine.js';

const todayStr = () => new Date().toLocaleDateString('sv-SE');

function weatherGrid(lat, lon, radiusKm) {
  // maglia fitta: i temporali sono locali (5 km fino a 20 km di raggio, 8 km fino a 50…)
  const step = radiusKm <= 20 ? 5 : radiusKm <= 50 ? 8 : radiusKm <= 100 ? 12 : 15;
  const dLat = step / 111.32, dLon = step / (111.32 * Math.cos((lat * Math.PI) / 180));
  const n = Math.ceil(radiusKm / step);
  const pts = [];
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
    const p = { lat: lat + i * dLat, lon: lon + j * dLon, i, j };
    if (distKm({ lat, lon }, p) <= radiusKm + step * 0.75) pts.push(p);
  }
  return { pts, dLat, dLon };
}

function nearestWeather(grid, byIJ, lat, lon, c) {
  const i = Math.round((lat - c.lat) / grid.dLat), j = Math.round((lon - c.lon) / grid.dLon);
  return byIJ.get(`${i},${j}`) || byIJ.get('0,0');
}

// colore overlay: giallo (marginale) -> verde (autunnale) / arancio (estivo)
function colorFor(score, groupKey) {
  const a = Math.min(1, Math.max(0, (score - 0.35) / 0.6));
  if (a <= 0) return [0, 0, 0, 0];
  const c1 = [250, 204, 21], c2 = groupKey === 'caldo' ? [234, 88, 12] : [22, 163, 74];
  return [c1[0] + (c2[0] - c1[0]) * a, c1[1] + (c2[1] - c1[1]) * a, c1[2] + (c2[2] - c1[2]) * a, 70 + 140 * a];
}

// Combina luogo, tempismo, stagione e bonus personali
// Combina luogo (con bonus margini/fungaie, max 1), suolo, timer e stagione: vedi finalScore
const combine = (place, tm, season, bonus) => finalScore(Math.min(1, place * bonus), tm.soil.factor, tm.timer, season);

export async function runAnalysis({ lat, lon, date, settings: s, learn, finds = [], onStep = () => {} }) {
  const radius = s.radiusKm;
  const center = { lat, lon };
  const aspectTarget = s.aspectPref && s.aspectPref !== 'auto' ? ASPECT_DEG[s.aspectPref] : null;
  const ahead = daysBetween(todayStr(), date);
  if (ahead > 15) throw new Error('La data può essere al massimo 15 giorni avanti (limite delle previsioni).');
  if (ahead < -60) throw new Error('La data non può essere più di 60 giorni fa.');
  // servono ~40 giorni prima della data per il bilancio idrico del suolo
  const pastDays = Math.min(92, Math.max(45, -ahead + 45));

  onStep('Scarico il meteo della tua zona…', 0.05);
  const [ref] = await fetchDaily([center], { pastDays, forecastDays: 16 });
  const summary = summarize(ref.days, date, s);

  onStep('Scarico l’altimetria…', 0.1);
  const mosaic = await loadMosaic(lat, lon, radius, { maxTiles: 64, onProgress: (p) => onStep('Scarico l’altimetria…', 0.1 + p * 0.25) });
  const valleyElev = Math.max(0, Math.round(mosaic.elevation(lat, lon)));

  // normale del periodo e classe di temperatura (per decidere la situazione A/B/C)
  onStep('Confronto con il clima normale del periodo…', 0.36);
  const clim = await climateFor(lat, lon, date, valleyElev, s.gradient);
  const tc = tempClass(summary, clim);

  const groups = activeGroups(date, s.species).map((g) => ({
    ...g,
    band: targetBand(summary.meanT, valleyElev, s.gradient, g.key, learn),
  }));

  // griglia di campionamento
  const stride = Math.max(1, Math.ceil(Math.sqrt((mosaic.W * mosaic.H) / 180000)));
  const OW = Math.ceil(mosaic.W / stride), OH = Math.ceil(mosaic.H / stride);

  onStep('Scarico la carta dei boschi (Copernicus)…', 0.37);
  let forest = null;
  try {
    const f = await forestRaster(mosaic.z, mosaic.ox, mosaic.oy, mosaic.ox + OW * stride, mosaic.oy + OH * stride, OW * 2, OH * 2);
    // riduci 2x2 -> frazione di bosco e tipo dominante per campione
    forest = { frac: new Float32Array(OW * OH), code: new Uint8Array(OW * OH) };
    for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) {
      let b = 0, c = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const v = f.codes[(y * 2 + dy) * f.w + x * 2 + dx];
        if (v === 1) b++; else if (v === 2) c++;
      }
      forest.frac[y * OW + x] = (b + c) / 4;
      forest.code[y * OW + x] = b + c === 0 ? 0 : b >= c ? 1 : 2;
    }
  } catch (e) { console.warn('forest raster', e); forest = null; }

  onStep('Scarico il meteo in quota…', 0.45);
  const grid = weatherGrid(lat, lon, radius);
  const wx = await fetchDaily(grid.pts, { pastDays, forecastDays: 16 });
  const byIJ = new Map();
  wx.forEach((w, k) => {
    w.i = grid.pts[k].i; w.j = grid.pts[k].j; byIJ.set(`${w.i},${w.j}`, w);
    // tempismo per tipo di bosco ("lepri" e "diesel"), a una quota rappresentativa
    w.timing = { quercia: evalTiming(w, date, s, 'quercia', 600, learn), faggio: evalTiming(w, date, s, 'faggio', 1250, learn) };
    // pioggia caduta in questa zona (suolo secco = piogge scarse)
    w.regime = regimeOf(w.timing.quercia.soil.cls === 'secco' ? 0 : w.timing.quercia.rainTotal, tc);
  });

  onStep('Applico le regole al territorio…', 0.58);
  await new Promise((r) => setTimeout(r, 30));
  const mpp = metersPerPixel(lat, mosaic.z);
  const saStep = Math.max(1, Math.round(70 / mpp));
  const img = new Uint8ClampedArray(OW * OH * 4);
  const cands = [];
  const ctx = { meanT: summary.meanT, meanMax: summary.meanMax, valleyElev, gradient: s.gradient, southOffsetM: s.southOffsetM, learn };
  const nearFinds = finds.filter((f) => f.lat && distKm(center, f) < radius + 5);

  const edgeAt = (x, y) => {
    // margini e radure: bosco presente ma non uniforme nell'intorno 3x3
    if (!forest) return 1;
    let sum = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= OW || yy >= OH) continue;
      sum += forest.frac[yy * OW + xx]; n++;
    }
    const m = sum / n;
    return m > 0.35 && m < 0.85 ? 1.08 : 1;
  };

  for (let oy = 0; oy < OH; oy++) {
    const py = oy * stride;
    const rowLat = mosaic.toLatLon(0, py).lat;
    for (let ox = 0; ox < OW; ox++) {
      const k = oy * OW + ox;
      if (forest && forest.frac[k] < 0.5) continue; // fuori dal bosco
      const px = ox * stride;
      const ll = { lat: rowLat, lon: mosaic.toLatLon(px, py).lon };
      if (distKm(center, ll) > radius) continue;
      const elevation = mosaic.at(px, py);
      if (elevation < 50 || elevation > 2100) continue;
      const { slope, aspect } = mosaic.slopeAspectPx(px, py, saStep);
      if (aspectTarget != null && (slope < 3 || angDiff(aspect, aspectTarget) > 30)) continue; // esposizione scelta
      const fk = cellForestKey(elevation, forest?.code[k]);
      const w = nearestWeather(grid, byIJ, ll.lat, ll.lon, center);
      const tm = w.timing[fk];
      let bonus = edgeAt(ox, oy);
      for (const f of nearFinds) {
        const d = distKm(ll, f);
        if (d < 2) bonus *= 1 + 0.25 * Math.exp(-(d * d) / 0.8);
      }
      let best = null;
      for (const g of groups) {
        const pl = evalPlace({ elevation, slope, aspect, forestKey: fk, regime: w.regime }, ctx, g.key);
        const fin = combine(pl.score, tm, g.weight, bonus);
        if (!best || fin > best.fin) best = { fin, pl, tm, g };
      }
      img.set(colorFor(best.pl.score * best.g.weight, best.g.key), k * 4);
      if (best.fin > 0.04) cands.push({ lat: ll.lat, lon: ll.lon, elevation, slope, aspect, fk, code: forest?.code[k] ?? null, ...best });
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = OW; canvas.height = OH;
  canvas.getContext('2d').putImageData(new ImageData(img, OW, OH), 0, 0);
  const nw = mosaic.toLatLon(0, 0), se = mosaic.toLatLon(OW * stride, OH * stride);
  const overlay = { url: canvas.toDataURL('image/png'), bounds: [[se.lat, nw.lon], [nw.lat, se.lon]] };

  // valutazione di un punto (usata nella scansione fine)
  const scoreCell = (ll, elevation, slope, aspect, code, edgeBonus) => {
    const fk = cellForestKey(elevation, code);
    const w = nearestWeather(grid, byIJ, ll.lat, ll.lon, center);
    const tm = w.timing[fk];
    let bonus = edgeBonus;
    for (const f of nearFinds) { const d = distKm(ll, f); if (d < 2) bonus *= 1 + 0.25 * Math.exp(-(d * d) / 0.8); }
    let best = null;
    for (const g of groups) {
      const pl = evalPlace({ elevation, slope, aspect, forestKey: fk, regime: w.regime }, ctx, g.key);
      const fin = combine(pl.score, tm, g.weight, bonus);
      if (!best || fin > best.fin) best = { fin, pl, tm, g };
    }
    return { fk, ...best };
  };

  // 2ª passata su un'area: terreno ~15 m, boschi 10 m, un punto ogni ~30 m entro 1,2 km
  const refineArea = async (c) => {
    const R = 1.2;
    const m = await loadMosaic(c.lat, c.lon, R, { maxTiles: 4, maxZoom: 13 });
    const mppF = metersPerPixel(c.lat, m.z);
    const st = Math.max(1, Math.round(30 / mppF));
    const FW = Math.ceil(m.W / st), FH = Math.ceil(m.H / st);
    let frac = null, codes = null;
    try {
      const f = await forestRaster(m.z, m.ox, m.oy, m.ox + FW * st, m.oy + FH * st, FW * 2, FH * 2);
      frac = new Float32Array(FW * FH); codes = new Uint8Array(FW * FH);
      for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
        let b = 0, cf = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const v = f.codes[(y * 2 + dy) * f.w + x * 2 + dx];
          if (v === 1) b++; else if (v === 2) cf++;
        }
        frac[y * FW + x] = (b + cf) / 4;
        codes[y * FW + x] = b + cf === 0 ? 0 : b >= cf ? 1 : 2;
      }
    } catch { /* senza carta dei boschi di dettaglio: tengo il giudizio della prima passata */ }
    const saF = Math.max(1, Math.round(45 / mppF));
    const cells = [];
    for (let fy = 0; fy < FH; fy++) {
      for (let fx = 0; fx < FW; fx++) {
        const px = fx * st, py = fy * st;
        const ll = m.toLatLon(px, py);
        if (distKm(c, ll) > R || distKm(center, ll) > radius) continue;
        const k = fy * FW + fx;
        if (frac && frac[k] < 0.5) continue;
        const elevation = m.at(px, py);
        if (elevation < 50 || elevation > 2100) continue;
        const { slope, aspect } = m.slopeAspectPx(px, py, saF);
        if (aspectTarget != null && (slope < 3 || angDiff(aspect, aspectTarget) > 30)) continue;
        // margini e radure: bosco presente ma non uniforme nei ~150 m attorno
        let edge = 1;
        if (frac) {
          let sum = 0, n = 0;
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            const xx = fx + dx, yy = fy + dy;
            if (xx < 0 || yy < 0 || xx >= FW || yy >= FH) continue;
            sum += frac[yy * FW + xx]; n++;
          }
          const mfr = sum / n;
          if (mfr > 0.35 && mfr < 0.85) edge = 1.08;
        }
        const r = scoreCell(ll, elevation, slope, aspect, codes ? codes[k] : c.code, edge);
        cells.push({ lat: ll.lat, lon: ll.lon, elevation, slope, aspect, code: codes ? codes[k] : c.code, fine: true, ...r });
      }
    }
    // i 3 punti migliori dell'area, ad almeno 400 m l'uno dall'altro
    cells.sort((a, b) => b.fin - a.fin);
    const out = [];
    for (const x of cells) {
      if (out.length >= 3) break;
      if (out.every((o) => distKm(o, x) >= 0.4)) out.push(x);
    }
    return out.length ? out : [c];
  };

  // 1ª passata: le aree più promettenti (anche vicine tra loro: conta solo la qualità)
  onStep('Seleziono le aree più promettenti…', 0.66);
  cands.sort((a, b) => b.fin - a.fin);
  const areas = [];
  const nAreas = Math.min(90, s.maxSpots * 3);
  for (const c of cands) {
    if (areas.length >= nAreas) break;
    if (areas.every((p) => distKm(p, c) >= 1.5)) areas.push(c);
  }

  // 2ª passata: scansione fine di ogni area
  const refined = [];
  let done = 0;
  const queue = [...areas];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const c = queue.shift();
      try { refined.push(...(await refineArea(c))); } catch { refined.push(c); }
      onStep(`Analisi di dettaglio delle aree migliori… ${++done}/${areas.length}`, 0.66 + (done / areas.length) * 0.22);
    }
  }));

  // i migliori in assoluto: unica regola, almeno 400 m tra uno spot e l'altro
  refined.sort((a, b) => b.fin - a.fin);
  const picked = [];
  for (const r of refined) {
    if (picked.length >= Math.ceil(s.maxSpots * 1.4)) break;
    if (picked.every((p) => distKm(p, r) >= 0.4)) picked.push(r);
  }

  // bosco nell'intorno di ogni spot (tipo e copertura per la scheda)
  onStep('Verifico il bosco attorno agli spot…', 0.89);
  const queue2 = [...picked];
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue2.length) {
      const c = queue2.shift();
      if (!c.fine) { try { const t = await terrainAtPoint(c.lat, c.lon); if (t.elevation > 0) Object.assign(c, t); } catch { /* dato della prima passata */ } }
      try { c.patch = await forestPatch(c.lat, c.lon); } catch { c.patch = null; }
    }
  }));

  onStep('Controllo le aree protette…', 0.92);
  let protectedFc = null;
  try { protectedFc = await fetchProtected(bboxAround(lat, lon, radius)); } catch { protectedFc = null; }

  const final = picked
    .filter((c) => !c.patch || c.patch.frac >= 0.25)
    // con il terreno di dettaglio l'esposizione può cambiare: tolleranza un po' più larga
    .filter((c) => aspectTarget == null || (c.slope >= 3 && angDiff(c.aspect, aspectTarget) <= 40))
    .map((c) => {
      const w = nearestWeather(grid, byIJ, c.lat, c.lon, center);
      const code = c.patch ? (c.patch.frac === 0 ? 0 : c.patch.broad >= c.patch.conif ? 1 : 2) : c.code;
      const fk = cellForestKey(c.elevation, code);
      const tm = evalTiming(w, date, s, fk, c.elevation, learn);
      // suolo secco conta come "piogge scarse" anche se nei 20 giorni è caduta la quantità minima
      const regime = regimeOf(tm.soil.cls === 'secco' ? 0 : tm.rainTotal, tc);
      const edge = c.patch && c.patch.frac > 0.3 && c.patch.frac < 0.85 ? 1.08 : 1;
      let best = null;
      for (const g of groups) {
        const pl = evalPlace({ elevation: c.elevation, slope: c.slope, aspect: c.aspect, forestKey: fk, regime }, ctx, g.key);
        let bonus = edge;
        for (const f of nearFinds) { const d = distKm(c, f); if (d < 2) bonus *= 1 + 0.25 * Math.exp(-(d * d) / 0.8); }
        const fin = combine(pl.score, tm, g.weight, bonus);
        if (!best || fin > best.fin) best = { fin, pl, g, bonus };
      }
      const luogo = Math.min(1, best.pl.score * best.bonus);
      return {
        lat: c.lat, lon: c.lon,
        elevation: Math.round(c.elevation), slope: Math.round(c.slope), aspect: Math.round(c.aspect),
        aspectLabel: aspectLabel(c.aspect, c.slope),
        group: best.g.key,
        species: best.g.species.map((k) => SPECIES[k].common),
        score: Math.round(best.fin * 100),
        soil: { theta: Math.round(tm.soil.theta * 100), cls: tm.soil.cls, label: tm.soil.label },
        // fattori 0–100 che compongono il voto
        parts: {
          luogo: Math.round(luogo * 100),
          suolo: Math.round(tm.soil.factor * 100),
          timer: Math.round(tm.timer * 100),
          stagione: Math.round(best.g.weight * 100),
          bonus: Math.round((best.bonus - 1) * 100),
        },
        fk,
        wIJ: `${w.i},${w.j}`,
        place: Math.round(luogo * 100),
        timing: Math.round(tm.timer * 100),
        tLocal: Math.round(best.pl.tLocal * 10) / 10,
        forest: FORESTS[fk].label,
        forestType: c.patch ? `${c.patch.type}, copertura ${Math.round(c.patch.frac * 100)}%` : null,
        edge: edge > 1,
        rainTotal: Math.round(tm.rainTotal),
        daysSince: tm.daysSince,
        killers: tm.killers,
        protected: protectedAt(protectedFc, c.lat, c.lon),
        nearFind: nearFinds.some((f) => distKm(c, f) < 1),
        regime,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, s.maxSpots)
    .map((sp, i) => ({ ...sp, id: `P${String(i + 1).padStart(2, '0')}` }));

  // Timer: dalla pioggia caduta nella zona dello spot migliore di ciascun tipo di bosco (fallback: valle)
  const timers = {};
  for (const fk of ['quercia', 'faggio']) {
    const top = final.find((sp) => sp.fk === fk);
    const w = top ? byIJ.get(top.wIJ) : null;
    const t = w ? bestDates(summarize(w.days, date, s), fk, learn) : null;
    timers[fk] = t ? { ...t, where: top.id } : bestDates(summary, fk, learn);
  }
  for (const sp of final) { delete sp.wIJ; }

  // Zone: partendo dallo spot migliore, gli spot entro 2 km da lui -> un'area compatta da girare in una sola uscita
  const zoneOf = new Map();
  let zi = 0;
  for (const sp of final) { // final è già ordinato dal migliore
    if (zoneOf.has(sp.id)) continue;
    zoneOf.set(sp.id, zi);
    for (const o of final) if (!zoneOf.has(o.id) && distKm(sp, o) <= 2) zoneOf.set(o.id, zi);
    zi++;
  }
  const zones = [];
  for (let z = 0; z < zi; z++) {
    const ms = final.filter((sp) => zoneOf.get(sp.id) === z).sort((a, b) => b.score - a.score);
    if (ms.length < 2) continue;
    // giro: dal migliore, sempre verso lo spot più vicino non ancora visto
    const order = [ms[0]], rest = ms.slice(1);
    let km = 0;
    while (rest.length) {
      const last = order[order.length - 1];
      rest.sort((a, b) => distKm(last, a) - distKm(last, b));
      km += distKm(last, rest[0]); order.push(rest.shift());
    }
    zones.push({
      spots: order.map((sp) => sp.id), count: ms.length, best: ms[0].score,
      mean: Math.round(ms.reduce((a, sp) => a + sp.score, 0) / ms.length),
      tourKm: Math.round(km * 10) / 10,
      lat: ms.reduce((a, sp) => a + sp.lat, 0) / ms.length, lon: ms.reduce((a, sp) => a + sp.lon, 0) / ms.length,
    });
  }
  // ordine: zone con spot migliori e più numerosi prima
  zones.sort((a, b) => (b.best + b.mean * 0.5 + b.count * 3) - (a.best + a.mean * 0.5 + a.count * 3));
  zones.forEach((z, i) => {
    z.id = String.fromCharCode(65 + (i % 26));
    for (const sid of z.spots) { const sp = final.find((x) => x.id === sid); sp.zone = z.id; }
  });

  // Le tue fungaie nel raggio: sempre valutate nel punto esatto, con il timer imparato da ciascuna
  onStep('Valuto le tue fungaie…', 0.94);
  const fungaie = [];
  for (const place of finds.filter((f) => f.lat != null && distKm(center, f) <= radius)) {
    try {
      let { elevation, slope, aspect } = place;
      if (elevation == null || slope == null || aspect == null) ({ elevation, slope, aspect } = await terrainAtPoint(place.lat, place.lon));
      let fk = place.forestKey;
      let patch = null;
      if (!fk) {
        try { patch = await forestPatch(place.lat, place.lon); } catch { patch = null; }
        const code = patch ? (patch.frac === 0 ? 0 : patch.broad >= patch.conif ? 1 : 2) : null;
        fk = cellForestKey(elevation, code);
      }
      // timer personale: i giorni ideali di questa fungaia diventano il centro della finestra
      const ideal = placeIdealDays({ ...place, forestKey: fk, elevation }, learn);
      const learnF = { ...learn, timer: { ...(learn?.timer || {}), [fk]: ideal.idealDays - TIMER_CENTER[fk] } };
      const w = nearestWeather(grid, byIJ, place.lat, place.lon, center);
      const tm = evalTiming(w, date, s, fk, elevation, learnF);
      const regime = regimeOf(tm.soil.cls === 'secco' ? 0 : tm.rainTotal, tc);
      let best = null;
      for (const g of groups) {
        const pl = evalPlace({ elevation, slope, aspect, forestKey: fk, regime }, ctx, g.key);
        const fin = combine(pl.score, tm, g.weight, 1);
        if (!best || fin > best.fin) best = { fin, pl, g };
      }
      const sm = placeSummary(place);
      fungaie.push({
        fungaia: true, placeId: place.id,
        lat: place.lat, lon: place.lon,
        elevation: Math.round(elevation), slope: Math.round(slope), aspect: Math.round(aspect),
        aspectLabel: aspectLabel(aspect, slope),
        group: best.g.key, species: best.g.species.map((k) => SPECIES[k].common),
        score: Math.round(best.fin * 100),
        soil: { theta: Math.round(tm.soil.theta * 100), cls: tm.soil.cls, label: tm.soil.label },
        parts: {
          luogo: Math.round(best.pl.score * 100), suolo: Math.round(tm.soil.factor * 100),
          timer: Math.round(tm.timer * 100), stagione: Math.round(best.g.weight * 100), bonus: 0,
        },
        fk, place: Math.round(best.pl.score * 100), timing: Math.round(tm.timer * 100),
        tLocal: Math.round(best.pl.tLocal * 10) / 10,
        forest: FORESTS[fk].label,
        forestType: patch ? `${patch.type}, copertura ${Math.round(patch.frac * 100)}%` : place.forest || null,
        rainTotal: Math.round(tm.rainTotal), daysSince: tm.daysSince, killers: tm.killers,
        protected: protectedAt(protectedFc, place.lat, place.lon),
        regime, idealDays: ideal.idealDays, idealSource: ideal.source,
        nPos: sm.nPos, total: sm.total, lastVisit: sm.lastPositive?.datetime || null,
      });
    } catch (e) { console.warn('fungaia', place.id, e); }
  }
  fungaie.sort((a, b) => b.score - a.score).forEach((f, i) => { f.id = `F${String(i + 1).padStart(2, '0')}`; });

  onStep('Disegno le curve della fascia di quota…', 0.96);
  const inRadius = (la, lo) => distKm(center, { lat: la, lon: lo }) <= radius;
  const contours = {};
  for (const g of groups) {
    contours[g.key] = {
      lo: Math.round(g.band.lo), hi: Math.round(g.band.hi),
      loLines: g.band.lo > 50 ? contourLines(mosaic, g.band.lo, { keep: inRadius }) : [],
      hiLines: g.band.hi > 50 ? contourLines(mosaic, g.band.hi, { keep: inRadius }) : [],
    };
  }

  onStep('Fatto', 1);
  return {
    createdAt: new Date().toISOString(),
    date, center, radius, valleyElev,
    settings: { gradient: s.gradient, windowDays: s.windowDays, rainMinMm: s.rainMinMm, aspectPref: s.aspectPref || 'auto' },
    summary, groups, timers, spots: final, fungaie, zones, overlay, contours,
    scan: { areas: areas.length, fine: true },
    protectedFc, forestChecked: !!forest, demZoom: mosaic.z,
    clim, tc,
  };
}
