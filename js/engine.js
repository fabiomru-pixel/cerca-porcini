// Motore delle regole (slide): gradiente termico, finestra termica, correttivi, timer, killer
import { SPECIES, GROUPS, FORESTS, KILLERS } from './config.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
export const addDays = (dateStr, n) => {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
export const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 864e5);

// ---------- Specie in base alla stagione ----------
export function activeGroups(dateStr, speciesSetting = 'auto') {
  if (speciesSetting !== 'auto') {
    const sp = SPECIES[speciesSetting];
    return [{ key: sp.group, species: [speciesSetting], weight: 1 }];
  }
  const month = Number(dateStr.slice(5, 7));
  const byGroup = {};
  for (const [k, sp] of Object.entries(SPECIES)) {
    if (!sp.months.includes(month)) continue;
    const g = (byGroup[sp.group] ||= { species: [], weight: 0 });
    g.species.push(k);
    g.weight = Math.max(g.weight, sp.peak.includes(month) ? 1 : 0.7);
  }
  const keys = Object.keys(byGroup);
  if (!keys.length) return [{ key: 'fresco', species: ['edulis'], weight: 1, offSeason: true }];
  return keys.map((k) => ({ key: k, ...byGroup[k] }));
}

// ---------- Finestra termica (con eventuale affinamento personale) ----------
export function thermalWindow(groupKey, learn) {
  const g = GROUPS[groupKey];
  const shift = learn?.[groupKey]?.tShift ?? 0;
  return { tMin: g.tMin + shift, tMax: g.tMax + shift };
}

export function forestTimer(forestKey, learn) {
  const t = FORESTS[forestKey].timer;
  const sh = learn?.timer?.[forestKey] ?? 0;
  return { start: t.start + sh, optStart: t.optStart + sh, optEnd: t.optEnd + sh, end: t.end + sh };
}

// ---------- Riepilogo meteo "di valle" (posizione dell'utente) ----------
export function rainEpisodes(days, fromIdx, toIdx, minMm) {
  // episodi = giorni consecutivi con pioggia >= 1 mm; valido se totale >= minMm
  const eps = [];
  let cur = null;
  for (let i = Math.max(0, fromIdx); i <= toIdx && i < days.length; i++) {
    const r = days[i].rain ?? 0;
    if (r >= 1) {
      if (!cur) cur = { startIdx: i, endIdx: i, total: 0 };
      cur.endIdx = i; cur.total += r;
    } else if (cur) { eps.push(cur); cur = null; }
  }
  if (cur) eps.push(cur);
  return eps.filter((e) => e.total >= minMm);
}

export function summarize(days, dateStr, s) {
  const idx = days.findIndex((d) => d.date === dateStr);
  if (idx < 0) throw new Error('Data fuori dall’intervallo meteo disponibile (max 15 giorni avanti)');
  const win = days.slice(Math.max(0, idx - s.windowDays), idx);
  const meanMax = avg(win.map((d) => d.tmax));
  const meanMin = avg(win.map((d) => d.tmin));
  const rainFrom = idx - s.rainWindowDays;
  const rainDays = days.slice(Math.max(0, rainFrom), idx);
  const rainTotal = rainDays.reduce((a, d) => a + (d.rain ?? 0), 0);
  const eps = rainEpisodes(days, rainFrom, idx - 1, s.rainEventMm).map((e) => ({
    start: days[e.startIdx].date, end: days[e.endIdx].date, total: e.total, daysSince: idx - e.endIdx,
  }));
  return {
    idx, date: dateStr, meanMax, meanMin, meanT: (meanMax + meanMin) / 2,
    rainTotal, rainOk: rainTotal >= s.rainMinMm, episodes: eps,
    lastEpisode: eps[eps.length - 1] || null,
    rainSeries: rainDays.map((d) => ({ date: d.date, rain: d.rain ?? 0 })),
    windowDays: win.map((d) => ({ date: d.date, tmax: d.tmax, tmin: d.tmin })),
    forecast: idx >= days.findIndex((d) => d.date === new Date().toLocaleDateString('sv-SE')),
  };
}

// Quota target: (T valle − T target) / gradiente × 100 + quota della valle
export function targetBand(meanT, valleyElev, gradient, groupKey, learn) {
  const { tMin, tMax } = thermalWindow(groupKey, learn);
  const lo = valleyElev + ((meanT - tMax) / gradient) * 100;
  const hi = valleyElev + ((meanT - tMin) / gradient) * 100;
  const mid = valleyElev + ((meanT - (tMin + tMax) / 2) / gradient) * 100;
  return { lo: Math.max(0, lo), hi: Math.max(0, hi), mid: Math.max(0, mid), tMin, tMax };
}

// ---------- Tipo di bosco atteso per quota (slide 19) ----------
export function forestByElevation(h) {
  if (h <= 900) return { key: 'quercia', w: 1 };
  if (h >= 1000) return { key: 'faggio', w: 1 };
  const w = (h - 900) / 100; // transizione
  return w < 0.5 ? { key: 'quercia', w: 1 - w } : { key: 'faggio', w };
}

// Bosco del punto: conifere in quota = "diesel" (abeti); altrimenti decide la quota
export function cellForestKey(h, code) {
  if (code === 2 && h >= 800) return 'faggio';
  return h < 950 ? 'quercia' : 'faggio';
}

export function forestTempOffset(h, forestKey) {
  if (forestKey) return FORESTS[forestKey].tempOffsetC;
  if (h <= 900) return FORESTS.quercia.tempOffsetC;
  if (h >= 1000) return FORESTS.faggio.tempOffsetC;
  const w = (h - 900) / 100;
  return FORESTS.quercia.tempOffsetC * (1 - w) + FORESTS.faggio.tempOffsetC * w;
}

// ---------- Idoneità del luogo ----------
// cell: {elevation, slope, aspect, forestKey?}; ctx: {meanT, valleyElev, gradient, southOffsetM, learn}
export function evalPlace(cell, ctx, groupKey) {
  const g = ctx.gradient;
  const { tMin, tMax } = thermalWindow(groupKey, ctx.learn);
  // Esposizione: Sud = come stare 150–200 m più in basso; Nord = più fresco. Ininfluente in piano.
  const expoFactor = clamp(cell.slope / 12, 0, 1);
  const southness = -Math.cos((cell.aspect * Math.PI) / 180); // +1 Sud, −1 Nord
  const expoC = ((ctx.southOffsetM * g) / 100) * southness * expoFactor;
  const forestC = forestTempOffset(cell.elevation, cell.forestKey);
  const tLocal = ctx.meanT - ((cell.elevation - ctx.valleyElev) * g) / 100 + expoC + forestC;

  // Punteggio termico: pieno dentro la finestra, cala di ~1/2 ogni 2 °C fuori
  let thermal;
  if (tLocal >= tMin && tLocal <= tMax) {
    const mid = (tMin + tMax) / 2, half = (tMax - tMin) / 2;
    thermal = 1 - 0.15 * Math.abs(tLocal - mid) / half;
  } else {
    const d = tLocal < tMin ? tMin - tLocal : tLocal - tMax;
    thermal = 0.85 * Math.exp(-(d * d) / (2 * 1.6 * 1.6));
  }

  // Fascia del bosco tipico della specie (querce 200–900 m, faggi 1000–1600 m)
  const fk = GROUPS[groupKey].forest;
  const f = FORESTS[fk];
  let band = 1;
  if (cell.elevation < f.altMin) band = Math.max(0.35, 1 - (f.altMin - cell.elevation) / 400);
  else if (cell.elevation > f.altMax) band = Math.max(0.35, 1 - (cell.elevation - f.altMax) / 400);

  // Pendenza ed esposizione secondo la situazione (A secco/caldo, B umido/fresco, C intermedia)
  const slopeS = slopeFactor(cell.slope, cell.regime || 'C');
  const expoPref = 1 + expoBonus(cell.aspect, cell.regime || 'C') * expoFactor;

  // la quota nasce dal calcolo termico: la fascia tipica del bosco è solo un indizio (peso ridotto)
  const score = clamp(thermal * (0.75 + 0.25 * band) * slopeS * expoPref, 0, 1.3);
  return { score, tLocal, thermal, band, slopeS, expoPref, expoC, forestC, forestKey: cell.forestKey || forestByElevation(cell.elevation).key };
}

// Interpolazione lineare a tratti su punti [x, y]
const piecewise = (x, pts) => {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
};

// A: piano/falsopiano 0–8° al massimo, ripido molto penalizzato
// B: pendenza media 10–25° al massimo, piano e ripido un po' penalizzati
// C: come prima, pianori premiati e ripido penalizzato
export function slopeFactor(slope, regime) {
  if (regime === 'A') return piecewise(slope, [[8, 1.15], [15, 1.0], [30, 0.6]]);
  if (regime === 'B') return piecewise(slope, [[5, 0.85], [10, 1.15], [25, 1.15], [35, 0.7]]);
  return piecewise(slope, [[8, 1], [35, 0.2]]);
}

// Bonus esposizione: pieno nelle due direzioni ideali, metà in quelle accanto, malus sul lato opposto
// A: ideale Nord–Nord-Est (centro 22,5°) · B: ideale Sud–Sud-Est (centro 157,5°)
export function expoBonus(aspect, regime) {
  if (regime !== 'A' && regime !== 'B') return 0;
  const target = regime === 'A' ? 22.5 : 157.5;
  const d = Math.abs((((aspect - target) % 360) + 540) % 360 - 180);
  return piecewise(d, [[22.5, 0.25], [67.5, 0.125], [112.5, -0.05], [157.5, -0.2]]);
}

// ---------- Timer dopo la pioggia ----------
export function timerScore(daysSince, t) {
  if (daysSince < t.start) return daysSince >= t.start - 2 ? 0.25 : 0.05;
  if (daysSince < t.optStart) return 0.5 + 0.5 * (daysSince - t.start) / Math.max(1, t.optStart - t.start);
  if (daysSince <= t.optEnd) return 1;
  if (daysSince <= t.end) return 1 - 0.7 * (daysSince - t.optEnd) / Math.max(1, t.end - t.optEnd);
  return 0.15;
}

// Tempismo in un punto meteo (pioggia locale, timer, killer). cellElev per correggere Tmin/Tmax in quota.
export function evalTiming(wp, dateStr, s, forestKey, cellElev, learn) {
  const days = wp.days;
  const idx = days.findIndex((d) => d.date === dateStr);
  const from = idx - s.rainWindowDays;
  const rainTotal = days.slice(Math.max(0, from), idx).reduce((a, d) => a + (d.rain ?? 0), 0);
  const eps = rainEpisodes(days, from, idx - 1, s.rainEventMm);
  const t = forestTimer(forestKey, learn);
  const dT = cellElev != null && wp.elevation != null ? ((cellElev - wp.elevation) * s.gradient) / 100 : 0;

  let best = { score: 0.05, daysSince: null, killers: [] };
  for (const e of eps) {
    const daysSince = idx - e.endIdx;
    let sc = timerScore(daysSince, t);
    const killers = [];
    for (let i = e.endIdx + 1; i <= idx; i++) {
      const d = days[i];
      if (!d) continue;
      if (d.tmin - dT <= KILLERS.frostC && !killers.includes('gelo')) killers.push('gelo');
      if (d.tmax - dT > KILLERS.heatC && !killers.includes('caldo')) killers.push('caldo');
      const dir = d.windDir, [a, b] = KILLERS.tramontanaDirs;
      const fromN = dir >= a || dir <= b;
      if (fromN && d.wind >= KILLERS.tramontanaKmh && !killers.includes('tramontana')) killers.push('tramontana');
    }
    sc *= Math.pow(0.4, killers.length);
    if (sc > best.score) best = { score: sc, daysSince, killers, total: e.total };
  }
  const rainFactor = rainTotal >= s.rainMinMm ? 1 : clamp(rainTotal / s.rainMinMm, 0, 1) * 0.5;
  return { score: best.score * rainFactor, timer: best.score, rainTotal, rainOk: rainTotal >= s.rainMinMm, daysSince: best.daysSince, killers: best.killers };
}

// Finestra di date consigliata (dall'ultimo episodio di pioggia valido)
export function bestDates(summary, forestKey, learn) {
  const e = summary.lastEpisode;
  if (!e) return null;
  const t = forestTimer(forestKey, learn);
  return { from: addDays(e.end, t.optStart), to: addDays(e.end, t.optEnd), firstPossible: addDays(e.end, t.start) };
}
