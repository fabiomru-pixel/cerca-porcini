// Analisi completa: meteo + altimetria + bosco + regole -> mappa di idoneità e spot consigliati
import { GROUPS, FORESTS, SPECIES, BUILT_MIN_M, BLOCK_KM } from './config.js';
import { loadMosaic, terrainAtPoint } from './dem.js';
import { fetchDaily } from './weather.js';
import { forestRaster, forestPatch, fetchProtected, protectedAt, builtRaster, nearBuiltGrid, canopyPatch } from './sources.js';
import { distKm, bboxAround, aspectLabel, metersPerPixel, ASPECT_DEG, angDiff } from './geo.js';
import { contourLines } from './contours.js';
import { climateFor, tempClass, regimeOf } from './climate.js';
import { placeIdealDays, placeSummary, TIMER_CENTER } from './finds.js';
import { loadGauges, applyGauges } from './gauges.js';
import { nearestRoad, walkMinutes } from './access.js';
import { wetness } from './hydro.js';
import {
  activeGroups, summarize, targetBand, evalPlace, evalTiming, bestDates, daysBetween, cellForestKey, finalScore, WIND_NAMES, staleFactor,
  WEAK_RAIN_FACTOR, microSoil, shelterOf, saturationFactor,
} from './engine.js';

const todayStr = () => new Date().toLocaleDateString('sv-SE');

// riassunto del vento dopo la pioggia per la scheda dello spot
const windInfo = (windF, wind) => {
  if (!wind?.events?.length) return null;
  const byK = {};
  for (const e of wind.events) { const b = (byK[e.k] ||= { k: e.k, name: WIND_NAMES[e.k], days: 0, max: 0, last: e.date }); b.days++; b.max = Math.max(b.max, e.kmh); b.last = e.date; }
  return { penalty: Math.round((1 - (windF ?? 1)) * 100), winds: Object.values(byK).sort((x, y) => y.days - x.days) };
};

function weatherGrid(lat, lon, radiusKm) {
  // maglia fitta (i temporali sono locali), ma al massimo ~45 punti: Open-Meteo pesa ogni punto per variabili,
  // modelli e giorni (limite gratuito 600 al minuto, 10.000 al giorno) e con 89 punti un'analisi ne valeva ~720.
  // La pioggia degli spot viene comunque dai pluviometri vicini, la temperatura dalla quota dello spot.
  const base = radiusKm <= 20 ? 5 : radiusKm <= 50 ? 8 : 12;
  const step = Math.max(base, radiusKm * 0.33); // ~45 punti al massimo, margine ai bordi compreso
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

// Riepilogo del microclima per la scheda dello spot (solo quando compensa davvero il suolo secco)
const microInfo = (wet, tm, soilEff) => (soilEff - tm.soil.factor >= 0.03 ? {
  water: !!wet && wet.m >= 0.2, distM: wet?.distM ?? null, hand: wet?.hand ?? null,
  rh: tm.air?.rh ?? null, windMean: tm.air?.wind ?? null,
  soilGain: Math.round((soilEff - tm.soil.factor) * 100),
} : null);

// Combina luogo, tempismo, stagione e bonus personali
// Combina luogo (con bonus margini/fungaie, max 1), suolo, timer e stagione: vedi finalScore
// + pioggia troppo vecchia (oltre 20 giorni, peggio se fa caldo): vedi staleFactor
// + microclima (sh = riparo: zona umida o versante Nord, vedi shelterOf): compensa il suolo secco con aria umida e calma
// + terreno saturo da una seconda pioggia (meno grave sulle pendenze che drenano)
const combine = (place, tm, season, bonus, hot, sh, slope) => finalScore(Math.min(1, place * bonus), microSoil(tm.soil.factor, sh, tm.air?.f), tm.timer, season)
  * staleFactor(tm.lastRainDays, hot, tm.staleDays) * (tm.weakRain ? WEAK_RAIN_FACTOR : 1)
  * (tm.sat ? saturationFactor(tm.sat, tm.sat.idx, slope) : 1);

export async function runAnalysis({ lat, lon, date, settings: s, learn, finds = [], empties = [], blocked = [], onStep = () => {} }) {
  // spot che hai segnato come inaccessibili (rovi, recinti, dirupi): l'area attorno resta fuori
  const isBlocked = (p) => blocked.some((b) => distKm(b, p) < BLOCK_KM);
  const radius = s.radiusKm;
  const center = { lat, lon };
  const aspectTarget = s.aspectPref && s.aspectPref !== 'auto' ? ASPECT_DEG[s.aspectPref] : null;
  // tipo di bosco scelto (querce/castagni o faggi/abeti); "auto" = tutti
  const forestPref = s.forestPref === 'quercia' || s.forestPref === 'faggio' ? s.forestPref : null;
  const ahead = daysBetween(todayStr(), date);
  if (ahead > 15) throw new Error('La data può essere al massimo 15 giorni avanti (limite delle previsioni).');
  if (ahead < -60) throw new Error('La data non può essere più di 60 giorni fa.');
  // servono ~40 giorni prima della data per il bilancio idrico del suolo
  const pastDays = Math.min(92, Math.max(41, -ahead + 41)); // 40 giorni per il bilancio del suolo

  onStep('Scarico il meteo della tua zona…', 0.05);
  // solo i giorni che servono: meno dati = meno "peso" sul limite del servizio gratuito
  const fDays = Math.max(1, ahead + 1);
  const onWait = (sec) => onStep(`Il servizio meteo è lento o chiede una pausa: riprovo tra ${sec} secondi…`, 0.45);
  onStep('Leggo i pluviometri SIR…', 0.04);
  const G = await loadGauges({ lat, lon, km: radius }); // pluviometri SIR (null fuori Toscana o se i dati sono vecchi)
  // pioggia del punto: misurata dai pluviometri vicini se ci sono, altrimenti media dei modelli
  const atPoint = (w, la, lo) => applyGauges({ ...w, lat: la, lon: lo, days: w.days.map((d) => ({ ...d, rain: d.rainModel ?? d.rain })) }, G);
  let [ref] = await fetchDaily([center], { pastDays, forecastDays: fDays, onWait });
  ref = applyGauges(ref, G);
  const summary = summarize(ref.days, date, s);

  onStep('Scarico l’altimetria…', 0.1);
  const mosaic = await loadMosaic(lat, lon, radius, { maxTiles: 64, onProgress: (p) => onStep('Scarico l’altimetria…', 0.1 + p * 0.25) });
  const valleyElev = Math.max(0, Math.round(mosaic.elevation(lat, lon)));
  onStep('Cerco fossi, torrenti e impluvi…', 0.35);
  const wetMain = wetness(mosaic);

  // normale del periodo e classe di temperatura (per decidere la situazione A/B/C)
  onStep('Confronto con il clima normale del periodo…', 0.36);
  const clim = await climateFor(lat, lon, date, valleyElev, s.gradient);
  const tc = tempClass(summary, clim);
  const hot = tc.high || tc.maxAnom; // caldo sopra la media del periodo

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

  // case e paesi: celle con un edificio entro BUILT_MIN_M escluse (riserva: senza la carta non escludo niente)
  let builtNear = null;
  try {
    const b = await builtRaster(mosaic.z, mosaic.ox, mosaic.oy, mosaic.ox + OW * stride, mosaic.oy + OH * stride, OW * 2, OH * 2);
    const cellM = metersPerPixel(lat, mosaic.z) * stride;
    builtNear = nearBuiltGrid(b, OW, OH, Math.max(0, Math.round(BUILT_MIN_M / cellM)));
  } catch (e) { console.warn('built raster', e); builtNear = null; }

  onStep('Scarico il meteo in quota…', 0.45);
  const grid = weatherGrid(lat, lon, radius);
  const wx = await fetchDaily(grid.pts, { pastDays, forecastDays: fDays, onWait,
    onProgress: (d, n) => onStep(`Scarico il meteo in quota… ${d}/${n} punti`, 0.45 + 0.1 * (d / Math.max(1, n))) });
  const byIJ = new Map();
  const prepWeather = (w) => {
    // tempismo per tipo di bosco ("lepri" e "diesel"), a una quota rappresentativa
    w.timing = { quercia: evalTiming(w, date, s, 'quercia', 600, learn), faggio: evalTiming(w, date, s, 'faggio', 1250, learn) };
    // pioggia caduta in questa zona (suolo secco = piogge scarse)
    w.regime = regimeOf(w.timing.quercia.soil.cls === 'secco' ? 0 : w.timing.quercia.rainTotal, tc);
  };
  wx.forEach((w, k) => { w.i = grid.pts[k].i; w.j = grid.pts[k].j; applyGauges(w, G); byIJ.set(`${w.i},${w.j}`, w); prepWeather(w); });

  onStep('Applico le regole al territorio…', 0.58);
  await new Promise((r) => setTimeout(r, 30));
  const mpp = metersPerPixel(lat, mosaic.z);
  const saStep = Math.max(1, Math.round(70 / mpp));
  const img = new Uint8ClampedArray(OW * OH * 4);
  const cands = [];
  const ctx = { meanT: summary.meanT, meanMax: summary.meanMax, valleyElev, gradient: s.gradient, southOffsetM: s.southOffsetM, learn };
  const nearFinds = finds.filter((f) => f.lat && distKm(center, f) < radius + 5);
  // bonus "vicino a una tua fungaia": conta la fungaia più vicina (fino a +25% sul posto, svanisce entro 2 km).
  // Prima i bonus di più fungaie si moltiplicavano: due luoghi salvati nello stesso punto davano +56%.
  const nearFindBonus = (p) => {
    let best = 0;
    for (const f of nearFinds) { const d = distKm(p, f); if (d < 2) best = Math.max(best, Math.exp(-(d * d) / 0.8)); }
    return 1 + 0.25 * best;
  };
  // tipo di bosco indicato da te in una fungaia entro 300 m: vale anche per gli spot attorno (stesso bosco,
  // stesso timer). La carta dei boschi a 900–1000 m confonde spesso faggi e castagni.
  const userForest = (p) => {
    let fk = null, bd = 0.3;
    for (const f of nearFinds) { if (!f.forestKey) continue; const d = distKm(p, f); if (d < bd) { bd = d; fk = f.forestKey; } }
    return fk;
  };
  // uscite a vuoto recenti: la zona è stata battuta senza trovare niente. Penalità entro 1,5 km che
  // svanisce in 3 settimane e si riduce molto se nel frattempo è tornata a piovere
  const nearEmpties = empties.filter((e) => e.lat && distKm(center, e) < radius + 5);
  const emptyFactor = (ll, tm) => {
    let f = 1;
    for (const e of nearEmpties) {
      const d = distKm(ll, e);
      if (d > 1.5) continue;
      const age = daysBetween(e.date, date);
      if (age < 0 || age > 21) continue;
      const rainedAfter = tm?.lastRainDate && tm.lastRainDate > e.date;
      f *= 1 - 0.45 * Math.exp(-(d * d) / 0.5) * (1 - age / 21) * (rainedAfter ? 0.3 : 1);
    }
    return f;
  };

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
      if (builtNear && builtNear[k]) continue;      // troppo vicino a case e paesi
      const px = ox * stride;
      const ll = { lat: rowLat, lon: mosaic.toLatLon(px, py).lon };
      if (blocked.length && isBlocked(ll)) continue;
      if (distKm(center, ll) > radius) continue;
      const elevation = mosaic.at(px, py);
      if (elevation < 50 || elevation > 2100) continue;
      const { slope, aspect } = mosaic.slopeAspectPx(px, py, saStep);
      if (aspectTarget != null && (slope < 3 || angDiff(aspect, aspectTarget) > 30)) continue; // esposizione scelta
      const fk = userForest(ll) || cellForestKey(elevation, forest?.code[k]);
      if (forestPref && fk !== forestPref) continue; // tipo di bosco scelto
      const w = nearestWeather(grid, byIJ, ll.lat, ll.lon, center);
      const tm = w.timing[fk];
      let bonus = edgeAt(ox, oy);
      bonus *= nearFindBonus(ll);
      bonus *= emptyFactor(ll, tm);
      const sh = shelterOf(wetMain.at(ll.lat, ll.lon).m, aspect, slope);
      let best = null;
      for (const g of groups) {
        const pl = evalPlace({ elevation, slope, aspect, forestKey: fk, regime: w.regime, wind: tm.wind }, ctx, g.key);
        const fin = combine(pl.score, tm, g.weight, bonus, hot, sh, slope);
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
  const scoreCell = (ll, elevation, slope, aspect, code, edgeBonus, areaW, wet) => {
    const fk = userForest(ll) || cellForestKey(elevation, code);
    if (forestPref && fk !== forestPref) return { fk, fin: 0, pl: { score: 0 }, tm: null, g: groups[0] };
    const w = areaW || nearestWeather(grid, byIJ, ll.lat, ll.lon, center);
    const tm = w.timing[fk];
    let bonus = edgeBonus;
    bonus *= nearFindBonus(ll);
    bonus *= emptyFactor(ll, tm);
    let best = null;
    for (const g of groups) {
      const pl = evalPlace({ elevation, slope, aspect, forestKey: fk, regime: w.regime, wind: tm.wind }, ctx, g.key);
      const fin = combine(pl.score, tm, g.weight, bonus, hot, shelterOf(wet?.m, aspect, slope), slope);
      if (!best || fin > best.fin) best = { fin, pl, tm, g };
    }
    return { fk, wet, ...best };
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
    let builtF = null;
    try {
      const b = await builtRaster(m.z, m.ox, m.oy, m.ox + FW * st, m.oy + FH * st, FW * 2, FH * 2);
      builtF = nearBuiltGrid(b, FW, FH, Math.max(1, Math.round(BUILT_MIN_M / (mppF * st))));
    } catch { builtF = null; }
    const saF = Math.max(1, Math.round(45 / mppF));
    const wetL = wetness(m); // sul terreno di dettaglio (~7 km attorno all'area: bacini completi)
    const cells = [];
    for (let fy = 0; fy < FH; fy++) {
      for (let fx = 0; fx < FW; fx++) {
        const px = fx * st, py = fy * st;
        const ll = m.toLatLon(px, py);
        if (distKm(c, ll) > R || distKm(center, ll) > radius) continue;
        if (blocked.length && isBlocked(ll)) continue;
        const k = fy * FW + fx;
        if (frac && frac[k] < 0.5) continue;
        if (builtF && builtF[k]) continue; // case e paesi
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
        const r = scoreCell(ll, elevation, slope, aspect, codes ? codes[k] : c.code, edge, c.w, wetL.at(ll.lat, ll.lon));
        if (!(r.fin > 0)) continue; // bosco diverso da quello scelto
        cells.push({ lat: ll.lat, lon: ll.lon, elevation, slope, aspect, code: codes ? codes[k] : c.code, fine: true, w: c.w, ...r });
      }
    }
    // i 3 punti migliori dell'area, ad almeno 400 m l'uno dall'altro
    cells.sort((a, b) => b.fin - a.fin);
    const out = [];
    for (const x of cells) {
      if (out.length >= 3) break;
      if (out.every((o) => distKm(o, x) >= 0.4)) out.push(x);
    }
    // area dello spot: i punti entro 500 m con almeno il 60% del suo valore (per la colorazione sulla mappa)
    for (const o of out) {
      o.heat = cells
        .filter((x) => x.fin >= 0.6 * o.fin && distKm(o, x) <= 0.5)
        .slice(0, 700)
        .map((x) => [Math.round(x.lat * 1e5) / 1e5, Math.round(x.lon * 1e5) / 1e5, Math.round(Math.max(0, Math.min(1, (x.fin / o.fin - 0.6) / 0.4)) * 100)]); // 0 = 60% dello spot, 100 = come lo spot
      o.heatCell = Math.round(st * mppF); // passo della griglia in metri
    }
    return out.length ? out : [c];
  };

  // 1ª passata: le aree più promettenti (anche vicine tra loro: conta solo la qualità)
  onStep('Seleziono le aree più promettenti…', 0.66);
  cands.sort((a, b) => b.fin - a.fin);
  // pioggia e suolo dai pluviometri vicini a ciascuna cella, non dal punto meteo della griglia (punti ogni 16 km)
  // le migliori 150 per ogni fascia di distanza (5 anelli): così anche il bosco vicino alla partenza viene ricalcolato
  const ring = (c) => Math.min(4, Math.floor((distKm(center, c) / radius) * 5));
  const perRing = [0, 0, 0, 0, 0];
  const toRescore = cands.filter((c) => perRing[ring(c)]++ < 150);
  for (const c of toRescore) {
    const w = atPoint(nearestWeather(grid, byIJ, c.lat, c.lon, center), c.lat, c.lon);
    const tm2 = evalTiming(w, date, s, c.fk, c.elevation, learn);
    const before = combine(c.pl.score, c.tm, c.g.weight, 1, hot, 0, c.slope);
    if (before > 0) c.fin *= combine(c.pl.score, tm2, c.g.weight, 1, hot, 0, c.slope) / before;
  }
  // a parità di qualità vince il più vicino: al massimo -3% al bordo del raggio (solo per l'ordine, non per il voto)
  const nearKey = (c) => c.fin * (1 - 0.03 * Math.min(1, distKm(center, c) / radius));
  cands.sort((a, b) => nearKey(b) - nearKey(a));
  const areas = [];
  const nAreas = Math.min(90, s.maxSpots * 3);
  // prima almeno 6 aree per ogni fascia di distanza (se c'è bosco): l'anello esterno ha molte più celle e
  // da solo riempiva tutte le aree da esaminare, senza dare occasione al bosco vicino alla partenza
  const ringTaken = [0, 0, 0, 0, 0];
  for (const c of cands) {
    if (areas.length >= nAreas) break;
    const rg = ring(c);
    if (ringTaken[rg] < 6 && areas.every((p) => distKm(p, c) >= 1.5)) { areas.push(c); ringTaken[rg]++; }
  }
  for (const c of cands) {
    if (areas.length >= nAreas) break;
    if (areas.every((p) => distKm(p, c) >= 1.5)) areas.push(c);
  }

  // meteo puntuale al centro di ogni area (la maglia larga dei raggi grandi non basta per la pioggia)
  onStep('Scarico il meteo puntuale delle aree migliori…', 0.66);
  try {
    // solo con raggi grandi (maglia larga) e per le 40 aree migliori: meno richieste al servizio gratuito
    const need = radius > 60 ? areas.slice(0, 40) : [];
    const aw = need.length ? await fetchDaily(need.map((c) => ({ lat: c.lat, lon: c.lon })), { pastDays, forecastDays: fDays, onWait,
      onProgress: (d, n) => onStep(`Scarico il meteo puntuale delle aree migliori… ${d}/${n}`, 0.66) }) : [];
    aw.forEach((w, k) => { applyGauges(w, G); prepWeather(w); need[k].w = w; });
  } catch (e) { console.warn('meteo aree', e); /* resta la maglia larga */ }
  const allWx = [...wx, ...areas.map((c) => c.w).filter(Boolean)];

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
  refined.sort((a, b) => nearKey(b) - nearKey(a));
  const picked = [];
  for (const r of refined) {
    if (picked.length >= Math.ceil(s.maxSpots * 2.2)) break; // margine: alcuni verranno esclusi perché lontani dalla strada
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
      try { c.canopy = await canopyPatch(c.lat, c.lon); } catch { c.canopy = null; }
    }
  }));

  onStep('Controllo le aree protette…', 0.92);
  let protectedFc = null;
  // con raggi grandi scarico le aree protette solo attorno a spot e fungaie (risposta più leggera)
  let pbb = bboxAround(lat, lon, radius);
  if (radius > 60) {
    const pts = [...picked, ...finds.filter((f) => f.lat != null && distKm(center, f) <= radius)];
    if (pts.length) {
      const m = 0.06; // ~5 km di margine
      pbb = {
        south: Math.min(...pts.map((p) => p.lat)) - m, north: Math.max(...pts.map((p) => p.lat)) + m,
        west: Math.min(...pts.map((p) => p.lon)) - m * 1.4, east: Math.max(...pts.map((p) => p.lon)) + m * 1.4,
      };
    }
  }
  try { protectedFc = await fetchProtected(pbb); } catch { protectedFc = null; }

  // chioma rada: luce a terra, sottobosco di rovi e arbusti, porcini più rari. Margini e radure valgono
  // il bonus solo se attorno la chioma resta fitta.
  const canopyF = (cp) => (!cp ? 1 : cp.mean >= 75 ? 1 : cp.mean <= 45 ? 0.82 : 0.82 + (0.18 * (cp.mean - 45)) / 30);
  const ranked = picked
    .filter((c) => !c.patch || c.patch.frac >= 0.25)
    .filter((c) => !isBlocked(c))
    // con il terreno di dettaglio l'esposizione può cambiare: tolleranza un po' più larga
    .filter((c) => aspectTarget == null || (c.slope >= 3 && angDiff(c.aspect, aspectTarget) <= 40))
    .map((c) => {
      // pioggia misurata nel punto esatto dello spot (pluviometri più vicini a lui)
      const w = atPoint(c.w || nearestWeather(grid, byIJ, c.lat, c.lon, center), c.lat, c.lon);
      const code = c.patch ? (c.patch.frac === 0 ? 0 : c.patch.broad >= c.patch.conif ? 1 : 2) : c.code;
      const fk = userForest(c) || cellForestKey(c.elevation, code);
      if (forestPref && fk !== forestPref) return null;
      const tm = evalTiming(w, date, s, fk, c.elevation, learn);
      // suolo secco conta come "piogge scarse" anche se nei 20 giorni è caduta la quantità minima
      const regime = regimeOf(tm.soil.cls === 'secco' ? 0 : tm.rainTotal, tc);
      const edge = c.patch && c.patch.frac > 0.3 && c.patch.frac < 0.85 && (!c.canopy || c.canopy.mean >= 75) ? 1.08 : 1;
      const wet = c.wet || wetMain.at(c.lat, c.lon);
      const sh = shelterOf(wet.m, c.aspect, c.slope);
      let best = null;
      for (const g of groups) {
        const pl = evalPlace({ elevation: c.elevation, slope: c.slope, aspect: c.aspect, forestKey: fk, regime, wind: tm.wind }, ctx, g.key);
        let bonus = edge * canopyF(c.canopy);
        bonus *= nearFindBonus(c);
        bonus *= emptyFactor(c, tm);
        const fin = combine(pl.score, tm, g.weight, bonus, hot, sh, c.slope);
        if (!best || fin > best.fin) best = { fin, pl, g, bonus };
      }
      const luogo = Math.min(1, best.pl.score * best.bonus);
      const soilEff = microSoil(tm.soil.factor, sh, tm.air?.f);
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
          suolo: Math.round(soilEff * 100),
          timer: Math.round(tm.timer * 100),
          stagione: Math.round(best.g.weight * 100),
          bonus: Math.round((best.bonus - 1) * 100),
        },
        micro: microInfo(wet, tm, soilEff),
        fk,
        _w: w,
        rainSrc: w.rainSrc,
        wind: windInfo(best.pl.windF, tm.wind),
        place: Math.round(luogo * 100),
        timing: Math.round(tm.timer * 100),
        tLocal: Math.round(best.pl.tLocal * 10) / 10,
        forest: FORESTS[fk].label,
        forestType: c.patch ? `${c.patch.type}, copertura ${Math.round(c.patch.frac * 100)}%` : null,
        heat: c.heat || null, heatCell: c.heatCell || 30,
        edge: edge > 1,
        canopy: c.canopy ? { mean: Math.round(c.canopy.mean), open: Math.round(c.canopy.open * 100) } : null,
        rainTotal: Math.round(tm.rainTotal),
        daysSince: tm.daysSince,
        killers: tm.killers,
        protected: protectedAt(protectedFc, c.lat, c.lon),
        nearFind: nearFinds.some((f) => distKm(c, f) < 1),
        nearEmpty: (() => { const e = nearEmpties.filter((x) => distKm(c, x) <= 1.5 && daysBetween(x.date, date) >= 0 && daysBetween(x.date, date) <= 21).sort((a, b) => distKm(c, a) - distKm(c, b))[0]; return e ? { date: e.date, m: Math.round(distKm(c, e) * 1000) } : null; })(),
        lastRainDays: tm.lastRainDays, lastRainDate: tm.lastRainDate, staleDays: tm.staleDays, rainEvent: tm.rainEvent, saturated: !!tm.sat,
        regime,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.score * (1 - 0.03 * Math.min(1, distKm(center, b) / radius))) - (a.score * (1 - 0.03 * Math.min(1, distKm(center, a) / radius))));

  // Raggiungibilità: strada percorribile in auto più vicina e minuti a piedi. Oltre il limite lo spot
  // non conta: nessuno cammina ore "alla cieca" verso un posto che non conosce.
  onStep('Controllo quanto sono lontani dalla strada…', 0.92);
  const maxWalk = s.maxWalkMin ?? 40;
  const final = [];
  let excludedFar = 0;
  for (const sp of ranked) {
    if (final.length >= s.maxSpots) break;
    let road = null;
    try { road = await nearestRoad(sp.lat, sp.lon); } catch { road = null; }
    if (road) {
      const roadElev = mosaic.elevation(road.lat, road.lon);
      const ascent = Number.isFinite(roadElev) && roadElev > -500 ? sp.elevation - roadElev : 0;
      sp.access = { road: { lat: road.lat, lon: road.lon, name: road.name }, distM: road.distM, ascent: Math.round(ascent), walkMin: walkMinutes(road.distM, ascent) };
      if (sp.access.walkMin > maxWalk) { excludedFar++; continue; }
    }
    final.push(sp);
    onStep('Controllo quanto sono lontani dalla strada…', 0.92 + (final.length / s.maxSpots) * 0.02);
  }
  final.forEach((sp, i) => { sp.id = `P${String(i + 1).padStart(2, '0')}`; });

  // Timer: dalla pioggia caduta nella zona dello spot migliore di ciascun tipo di bosco (fallback: valle)
  const timers = {};
  for (const fk of ['quercia', 'faggio']) {
    const top = final.find((sp) => sp.fk === fk);
    const w = top ? top._w : null;
    const t = w ? bestDates(summarize(w.days, date, s), fk, learn) : null;
    timers[fk] = t ? { ...t, where: top.id } : bestDates(summary, fk, learn);
  }
  for (const sp of final) { delete sp._w; }


  // Le tue fungaie nel raggio: sempre valutate nel punto esatto, con il timer imparato da ciascuna
  onStep('Valuto le tue fungaie…', 0.94);
  const fungaie = [];
  for (const place of finds.filter((f) => f.lat != null && distKm(center, f) <= radius)) {
    try {
      let { elevation, slope, aspect } = place;
      if (!(elevation > -500) || slope == null || aspect == null) ({ elevation, slope, aspect } = await terrainAtPoint(place.lat, place.lon));
      let fk = place.forestKey;
      let patch = null;
      if (!fk) {
        try { patch = await forestPatch(place.lat, place.lon); } catch { patch = null; }
        const code = patch ? (patch.frac === 0 ? 0 : patch.broad >= patch.conif ? 1 : 2) : null;
        fk = cellForestKey(elevation, code);
      }
      // timer personale: i giorni ideali di questa fungaia diventano il centro della finestra
      const ideal = placeIdealDays({ ...place, forestKey: fk, elevation }, learn);
      const w0 = allWx.reduce((b, x) => (distKm(place, x) < distKm(place, b) ? x : b), allWx[0]);
      const w = atPoint(w0, place.lat, place.lon);
      const tm = evalTiming(w, date, s, fk, elevation, learn); // stesso timer degli spot
      const regime = regimeOf(tm.soil.cls === 'secco' ? 0 : tm.rainTotal, tc);
      const fBonus = nearFindBonus(place) * emptyFactor(place, tm);
      const fWet = wetMain.at(place.lat, place.lon);
      const fSh = shelterOf(fWet.m, aspect, slope);
      const fSoil = microSoil(tm.soil.factor, fSh, tm.air?.f);
      let best = null;
      for (const g of groups) {
        const pl = evalPlace({ elevation, slope, aspect, forestKey: fk, regime, wind: tm.wind }, ctx, g.key);
        const fin = combine(pl.score, tm, g.weight, fBonus, hot, fSh, slope);
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
          luogo: Math.round(Math.min(1, best.pl.score * fBonus) * 100), suolo: Math.round(fSoil * 100),
          timer: Math.round(tm.timer * 100), stagione: Math.round(best.g.weight * 100), bonus: Math.round((fBonus - 1) * 100),
        },
        fk, place: Math.round(best.pl.score * 100), timing: Math.round(tm.timer * 100),
        tLocal: Math.round(best.pl.tLocal * 10) / 10,
        forest: FORESTS[fk].label,
        forestType: patch ? `${patch.type}, copertura ${Math.round(patch.frac * 100)}%` : place.forest || null,
        rainTotal: Math.round(tm.rainTotal), daysSince: tm.daysSince, killers: tm.killers,
        lastRainDays: tm.lastRainDays, lastRainDate: tm.lastRainDate, staleDays: tm.staleDays, rainEvent: tm.rainEvent, saturated: !!tm.sat,
        protected: protectedAt(protectedFc, place.lat, place.lon),
        regime, idealDays: ideal.idealDays, idealSource: ideal.source,
        rainSrc: w.rainSrc,
        wind: windInfo(best.pl.windF, tm.wind),
        micro: microInfo(fWet, tm, fSoil),
        nPos: sm.nPos, total: sm.total, lastVisit: sm.lastPositive?.datetime || null,
      });
    } catch (e) { console.warn('fungaia', place.id, e); }
  }
  fungaie.sort((a, b) => b.score - a.score).forEach((f, i) => { f.id = `F${String(i + 1).padStart(2, '0')}`; });

  // Zone: partendo dallo spot migliore, gli spot entro 1,5 km da lui (quindi mai più di 3 km tra due spot)
  // e senza una valle profonda in mezzo: il fondovalle allunga molto il giro reale.
  // Le tue fungaie vicine agli spot della zona entrano nel giro.
  const valleyBetween = (a, b) => {
    const low = Math.min(a.elevation, b.elevation);
    for (let t = 0.1; t < 1; t += 0.1) {
      const e = mosaic.elevation(a.lat + (b.lat - a.lat) * t, a.lon + (b.lon - a.lon) * t);
      if (Number.isFinite(e) && e > -500 && low - e > 150) return true; // si scende più di 150 m sotto lo spot più basso
    }
    return false;
  };
  const zoneOf = new Map();
  let zi = 0;
  for (const sp of final) { // final è già ordinato dal migliore
    if (zoneOf.has(sp.id)) continue;
    zoneOf.set(sp.id, zi);
    for (const o of final) if (!zoneOf.has(o.id) && distKm(sp, o) <= 1.5 && !valleyBetween(sp, o)) zoneOf.set(o.id, zi);
    zi++;
  }
  // fungaie: nella zona dello spot più vicino, se entro 800 m da uno spot e 1,5 km dal migliore, senza valle in mezzo
  for (const fg of fungaie) {
    let bestSp = null;
    for (const sp of final) if (!bestSp || distKm(fg, sp) < distKm(fg, bestSp)) bestSp = sp;
    if (!bestSp || distKm(fg, bestSp) > 0.8 || valleyBetween(fg, bestSp)) continue;
    const z = zoneOf.get(bestSp.id);
    const head = final.find((sp) => zoneOf.get(sp.id) === z);
    if (distKm(fg, head) <= 1.5) zoneOf.set(fg.id, z);
  }
  const zones = [];
  for (let z = 0; z < zi; z++) {
    const ms = final.filter((sp) => zoneOf.get(sp.id) === z).sort((a, b) => b.score - a.score);
    const fs = fungaie.filter((fg) => zoneOf.get(fg.id) === z);
    const all = [...ms, ...fs];
    if (all.length < 2) continue;
    // partenza: lo spot più vicino alla strada; il giro va sempre al punto più vicino non ancora visto e torna lì
    const withRoad = ms.filter((sp) => sp.access).sort((a, b) => a.access.walkMin - b.access.walkMin);
    const first = withRoad[0] || ms[0];
    const order = [first], rest = all.filter((p) => p !== first);
    let km = 0;
    while (rest.length) {
      const last = order[order.length - 1];
      rest.sort((a, b) => distKm(last, a) - distKm(last, b));
      km += distKm(last, rest[0]); order.push(rest.shift());
    }
    km += distKm(order[order.length - 1], first); // ritorno allo spot di partenza
    zones.push({
      parking: withRoad.length ? { ...withRoad[0].access.road, walkMin: withRoad[0].access.walkMin, spot: withRoad[0].id } : null,
      spots: order.map((p) => p.id), count: ms.length, fungaie: fs.length, best: ms[0].score,
      mean: Math.round(ms.reduce((a, sp) => a + sp.score, 0) / ms.length),
      tourKm: Math.round(km * 10) / 10,
      lat: all.reduce((a, p) => a + p.lat, 0) / all.length, lon: all.reduce((a, p) => a + p.lon, 0) / all.length,
    });
  }
  // ordine: zone con spot migliori e più numerosi prima (una tua fungaia conta come uno spot in più)
  const zrank = (z) => z.best + z.mean * 0.5 + (z.count + z.fungaie) * 3;
  zones.sort((a, b) => zrank(b) - zrank(a));
  zones.forEach((z, i) => {
    z.id = String.fromCharCode(65 + (i % 26));
    for (const pid of z.spots) { const p = final.find((x) => x.id === pid) || fungaie.find((x) => x.id === pid); p.zone = z.id; }
  });

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
    settings: { gradient: s.gradient, windowDays: s.windowDays, rainMinMm: s.rainMinMm, aspectPref: s.aspectPref || 'auto', forestPref: s.forestPref || 'auto' },
    summary, groups, timers, spots: final, fungaie, zones, overlay, contours,
    scan: { areas: areas.length, fine: true, excludedFar, maxWalk },
    protectedFc, forestChecked: !!forest, demZoom: mosaic.z,
    clim, tc,
  };
}
