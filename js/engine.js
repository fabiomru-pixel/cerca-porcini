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

// Pioggia che avvia il timer (regola dell'utente, ottobre 2026): negli ultimi 20 giorni conta la pioggia
// più VECCHIA che, sommando i giorni di pioggia consecutivi, arriva ad almeno 15 mm; il timer parte il giorno
// in cui la somma tocca i 15 mm. Le piogge successive non lo fanno ripartire.
// Se nessun episodio arriva a 15 mm: il più vecchio da almeno minMm (10) avvia comunque il timer, con −20% sul voto.
export const RAIN_FULL_MM = 15;
export const WEAK_RAIN_FACTOR = 0.8;
export function timerRain(days, fromIdx, toIdx, minMm) {
  const eps = rainEpisodes(days, fromIdx, toIdx, minMm);
  for (const e of eps) {
    if (e.total < RAIN_FULL_MM) continue;
    let c = 0, k = e.startIdx;
    for (; k <= e.endIdx; k++) { c += days[k].rain ?? 0; if (c >= RAIN_FULL_MM) break; }
    return { ...e, timerIdx: Math.min(k, e.endIdx), weak: false };
  }
  return eps.length ? { ...eps[0], timerIdx: eps[0].endIdx, weak: true } : null;
}

// ---------- Seconda pioggia su un timer già avviato ----------
// Regola dell'utente (ottobre 2026): l'effetto di una nuova pioggia dipende dallo stato del suolo quando arriva,
// non dai millimetri. Tre domande: la pioggia precedente c'è ancora? il suolo è elastico o polveroso? nei giorni
// in mezzo il bosco ha conservato l'umidità (vento teso, caldo) o no (notti umide)? Tre esiti:
//  - nuovo timer ("vero nuovo impulso"): suolo ormai secco, o prima pioggia scarsa (<15 mm) -> il timer riparte;
//  - rinforzo ("reintegro"): suolo ancora umido o al limite -> il timer continua e la finestra si allunga;
//  - stop ("saturazione"): suolo già saturo e nuova pioggia abbondante -> voto ridotto per alcuni giorni.
// Quercia e castagno restano un unico bosco (la carta Copernicus non li distingue): valori medi tra i due
// (castagno drena benissimo e quasi non satura, quercia secca prima e satura di più).
export const SECOND_RAIN = {
  quercia: { resetBelow: 0.30, satWeight: 0.6 },
  faggio: { resetBelow: 0.25, satWeight: 1.0 },
  satAbove: 0.85, satMinMm: 20, satDays: 6, satPenalty: 0.35,
};
export function timerState(days, fromIdx, toIdx, s, forestKey) {
  const eps = rainEpisodes(days, fromIdx, toIdx, s.rainEventMm);
  if (!eps.length) return null;
  const P = SECOND_RAIN[forestKey] || SECOND_RAIN.quercia;
  const trigger = (e) => { // giorno in cui la somma arriva a 15 mm (o fine episodio se non ci arriva)
    if (e.total < RAIN_FULL_MM) return e.endIdx;
    let c = 0;
    for (let k = e.startIdx; k <= e.endIdx; k++) { c += days[k].rain ?? 0; if (c >= RAIN_FULL_MM) return k; }
    return e.endIdx;
  };
  let cur = { ...eps[0], timerIdx: trigger(eps[0]), weak: eps[0].total < RAIN_FULL_MM };
  let ext = 0, sat = null, event = null;
  for (const e of eps.slice(1)) {
    const theta = soilMoisture(days, e.startIdx - 1);
    // giorni in mezzo: il vento teso e il caldo asciugano più di quanto dica l'evaporazione, le giornate umide conservano
    let adj = 0;
    for (let i = cur.timerIdx + 1; i < e.startIdx; i++) {
      const d = days[i];
      if (windLoad(d) > 0) adj -= 0.04;
      if (d.tmax >= 26) adj -= 0.03;
      if (d.rh != null && d.rh >= 85) adj += 0.02;
    }
    const thetaEff = theta + Math.max(-0.15, Math.min(0.1, adj));
    const date = days[e.endIdx].date, mm = Math.round(e.total);
    if ((cur.weak && e.total >= RAIN_FULL_MM) || thetaEff < P.resetBelow) {
      cur = { ...e, timerIdx: trigger(e), weak: e.total < RAIN_FULL_MM };
      ext = 0; sat = null;
      event = { type: 'nuovo', date, mm, theta: Math.round(theta * 100) };
    } else if (theta >= SECOND_RAIN.satAbove && e.total >= SECOND_RAIN.satMinMm) {
      sat = { endIdx: e.endIdx, weight: P.satWeight };
      event = { type: 'saturazione', date, mm, theta: Math.round(theta * 100) };
    } else {
      ext = Math.max(ext, Math.min(6, Math.round(2 + e.total / 15)));
      event = { type: 'rinforzo', date, mm, theta: Math.round(theta * 100) };
    }
  }
  return { timerIdx: cur.timerIdx, total: cur.total, weak: cur.weak, ext, sat, event };
}
// Penalità per terreno saturo: piena nei giorni subito dopo la pioggia, dimezzata sulle pendenze che drenano (>15°)
export function saturationFactor(sat, idx, slope) {
  if (!sat) return 1;
  const since = idx - sat.endIdx;
  if (since < 0 || since > SECOND_RAIN.satDays) return 1;
  return 1 - SECOND_RAIN.satPenalty * sat.weight * (slope != null && slope > 15 ? 0.5 : 1);
}

export function summarize(days, dateStr, s) {
  const idx = days.findIndex((d) => d.date === dateStr);
  if (idx < 0) throw new Error('Data fuori dall’intervallo meteo disponibile (max 15 giorni avanti)');
  const win = days.slice(Math.max(0, idx - s.windowDays), idx);
  const meanMax = avg(win.map((d) => d.tmax));
  const meanMin = avg(win.map((d) => d.tmin));
  // 20 giorni compreso il giorno scelto: la pioggia già caduta (o prevista) quel giorno conta
  const rainFrom = idx - s.rainWindowDays + 1;
  const rainDays = days.slice(Math.max(0, rainFrom), idx + 1);
  const rainTotal = rainDays.reduce((a, d) => a + (d.rain ?? 0), 0);
  const eps = rainEpisodes(days, rainFrom, idx, s.rainEventMm).map((e) => ({
    start: days[e.startIdx].date, end: days[e.endIdx].date, total: e.total, daysSince: idx - e.endIdx,
  }));
  const tr = timerRain(days, rainFrom, idx, s.rainEventMm);
  return {
    idx, date: dateStr, meanMax, meanMin, meanT: (meanMax + meanMin) / 2,
    rainTotal, rainOk: rainTotal >= s.rainMinMm, episodes: eps,
    timerEpisode: tr ? { start: days[tr.startIdx].date, end: days[tr.timerIdx].date, total: tr.total, weak: tr.weak, daysSince: idx - tr.timerIdx } : null,
    soilTheta: soilMoisture(days, idx),
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
  const slopeS = slopeFactor(cell.slope, cell.regime || 'C', cell.aspect);
  // + quanto hai imparato sul campo: tasso di successo per versante nella stessa situazione
  const learnedExpo = ctx.learn?.expo?.[cell.regime || 'C']?.[Math.round(cell.aspect / 45) % 8] || 0;
  const expoPref = 1 + (expoBonus(cell.aspect, cell.regime || 'C') + learnedExpo) * expoFactor;

  // la quota nasce dal calcolo termico: la fascia tipica del bosco è solo un indizio (peso ridotto).
  // Pendenza ed esposizione sono riportate a 0–1 dividendo per il loro massimo nella situazione:
  // il "luogo" vale 1 solo se temperatura, fascia, pendenza ed esposizione sono tutte ideali.
  const terrainMax = cell.regime === 'A' || cell.regime === 'B' ? 1.15 * 1.25 : 1.15;
  // vento dopo la pioggia: i versanti colpiti si asciugano (tramontana -> esposti a N, ecc.)
  const windF = windFactor(cell.aspect, cell.slope, cell.wind);
  const score = clamp(((thermal * (0.75 + 0.25 * band) * slopeS * expoPref) / terrainMax) * windF, 0, 1);
  return { score, tLocal, thermal, band, slopeS, expoPref, expoC, forestC, windF, forestKey: cell.forestKey || forestByElevation(cell.elevation).key };
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

// A: piano/falsopiano 0–8° al massimo, ripido penalizzato
// B: pendenza media 10–25° al massimo, piano e ripido un po' penalizzati
// C: pianori leggermente preferiti, ripido poco penalizzato
// Versanti Nord–NE (A e C): più sono ripidi, meno sole prendono e più restano freschi e umidi.
// Ritrovamenti dell'utente (set–ott 2026): tutti tra NO ed E, pendenza media 17° (8–25°), nessuno sotto
// gli 8° tranne uno; uscite a vuoto su Nord quasi piani. Lì niente penalità fino a 30°, premio 12–22°.
const SLOPE_NORTH = [[0, 1.0], [8, 1.05], [12, 1.15], [22, 1.15], [30, 1.0], [40, 0.6]];
export function slopeFactor(slope, regime, aspect = 180) {
  if (regime === 'B') return piecewise(slope, [[5, 0.85], [10, 1.15], [25, 1.15], [35, 0.7]]);
  const other = regime === 'A'
    ? piecewise(slope, [[8, 1.15], [15, 1.0], [30, 0.6]])
    : piecewise(slope, [[8, 1], [25, 0.85], [35, 0.6]]);
  // quanto il versante guarda a Nord: 1 da NO a NE, ~0,45 a Est/Ovest, 0 da SE a SO; in piano conta poco
  const north = clamp((Math.cos((aspect * Math.PI) / 180) + 0.6) / 1.3, 0, 1) * clamp(slope / 12, 0, 1);
  return north * piecewise(slope, SLOPE_NORTH) + (1 - north) * other;
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
// Curva continua (nessuno scalino): un giorno di differenza nella pioggia misurata tra due spot vicini
// cambia il timer di poco. Prima saltava 0,05 → 0,25 → 0,5 in due giorni (voti 25 contro 41 a 500 m).
export function timerScore(daysSince, t) {
  const optStart = Math.max(t.start, t.optStart), optEnd = Math.max(optStart, t.optEnd), end = Math.max(optEnd + 1, t.end);
  return piecewise(daysSince, [[t.start - 5, 0.05], [optStart, 1], [optEnd, 1], [end, 0.3], [end + 5, 0.15]]);
}

// Tempismo in un punto meteo (pioggia locale, timer, killer). cellElev per correggere Tmin/Tmax in quota.
export function evalTiming(wp, dateStr, s, forestKey, cellElev, learn) {
  const days = wp.days;
  const idx = days.findIndex((d) => d.date === dateStr);
  const from = idx - s.rainWindowDays + 1; // 20 giorni compreso il giorno scelto
  const rainTotal = days.slice(Math.max(0, from), idx + 1).reduce((a, d) => a + (d.rain ?? 0), 0);
  const eps = rainEpisodes(days, from, idx, s.rainEventMm);
  const t = forestTimer(forestKey, learn);
  const dT = cellElev != null && wp.elevation != null ? ((cellElev - wp.elevation) * s.gradient) / 100 : 0;
  // i faggi (timer "diesel") fruttificano fino a ~24 giorni dopo la pioggia: la pioggia del timer si cerca
  // fino a quel giorno, e la penalità "pioggia vecchia" parte solo dopo. Querce e castagni restano a 20.
  const longTimer = forestKey === 'faggio';
  const timerFrom = longTimer ? Math.min(from, idx - t.end) : from;
  const staleDays = longTimer ? Math.max(STALE_DAYS, t.end) : STALE_DAYS;

  let best = { score: 0.05, daysSince: null, killers: [], weak: false };
  const tr = timerState(days, timerFrom, idx, s, forestKey);
  if (tr) {
    const daysSince = idx - tr.timerIdx;
    // rinforzo: la seconda pioggia allunga la finestra di qualche giorno
    const tx = tr.ext ? { ...t, optEnd: t.optEnd + tr.ext, end: t.end + tr.ext } : t;
    let sc = timerScore(daysSince, tx);
    const killers = [];
    for (let i = tr.timerIdx + 1; i <= idx; i++) {
      const d = days[i];
      if (!d) continue;
      if (d.tmin - dT <= KILLERS.frostC && !killers.includes('gelo')) killers.push('gelo');
      if (d.tmax - dT > KILLERS.heatC && !killers.includes('caldo')) killers.push('caldo');
      // il vento non ferma più il timer di tutta la zona: penalizza i versanti che colpisce (vedi windLoads)
    }
    sc *= Math.pow(0.4, killers.length);
    best = { score: Math.max(0.05, sc), daysSince, killers, total: tr.total, weak: tr.weak };
  }
  const soil = soilState(days, idx, rainTotal, s, learn);
  // vento dall'ultima pioggia utile (o negli ultimi 20 giorni se non ce n'è)
  const lastEp = eps[eps.length - 1];
  const wind = windLoads(days, lastEp ? lastEp.endIdx + 1 : Math.max(0, from), idx);
  // ultima pioggia utile in assoluto (anche oltre i 20 giorni, fin dove arrivano i dati)
  const anyEps = rainEpisodes(days, 0, idx, s.rainEventMm);
  const lastAny = anyEps[anyEps.length - 1];
  const lastRainDays = lastAny ? idx - lastAny.endIdx : null;
  const lastRainDate = lastAny ? days[lastAny.endIdx].date : null;
  return {
    timer: best.score, rainTotal, rainOk: rainTotal >= s.rainMinMm,
    daysSince: best.daysSince, killers: best.killers, soil, wind, lastRainDays, lastRainDate,
    weakRain: best.weak, // pioggia sotto i 15 mm: voto −20%
    rainEvent: tr?.event || null, // ultima pioggia arrivata sul timer: nuovo / rinforzo / saturazione
    sat: tr?.sat && idx - tr.sat.endIdx <= SECOND_RAIN.satDays ? { ...tr.sat, idx } : null,
    staleDays, // oltre questi giorni dall'ultima pioggia il voto si riduce (20; faggi fino a fine timer)
    air: airMoisture(days, idx), // umidità dell'aria e calma di vento negli ultimi 7 giorni
  };
}

// ---------- Microclima umido ----------
// Nei periodi secchi i porcini nascono lo stesso dove l'aria resta umida e non c'è vento che asciuga,
// soprattutto vicino a fossi e torrenti e negli impluvi (riscontro dell'utente, ottobre 2026).
// Aria: umidità media dei 7 giorni fino al giorno scelto, piena da 75%, nulla sotto 60%;
// calma: vento medio sotto 8 km/h pieno, sopra 15 km/h nullo.
const rampE = (x, a, b) => Math.max(0, Math.min(1, (x - a) / (b - a)));
export function airMoisture(days, idx, n = 7) {
  const win = days.slice(Math.max(0, idx - n + 1), idx + 1);
  const mean = (xs) => { const v = xs.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const rh = mean(win.map((d) => d.rh)), wind = mean(win.map((d) => d.windMean));
  if (rh == null) return null;
  const f = rampE(rh, 60, 75) * (wind == null ? 1 : 1 - rampE(wind, 8, 15));
  return { rh: Math.round(rh), wind: wind == null ? null : Math.round(wind), f };
}
// Riparo che trattiene l'umidità (0–1): zona umida vicino a fossi/impluvi OPPURE versante Nord–NE inclinato.
// I ritrovamenti dell'utente sono tutti su versanti Nord–Est lontani dai fossi (117–690 m, 30–213 m sopra):
// niente premio fisso al fondovalle, il microclima conta solo come compensazione del suolo secco.
export function shelterOf(wetM, aspect, slope) {
  const north = Math.max(0, Math.min(1, (Math.cos((aspect * Math.PI) / 180) + 0.6) / 1.3)) * rampE(slope, 4, 12);
  return Math.max(wetM || 0, north);
}
// Suolo con microclima: con riparo (0–1) e aria umida e calma (airF 0–1) si recupera fino a metà del suolo
// che manca (suolo 30 -> 65 con aria all'85% senza vento). Con il suolo già bagnato non cambia niente.
export const MICRO_SOIL_MAX = 0.5;
export function microSoil(soilF, shelter, airF) {
  return soilF + (1 - soilF) * MICRO_SOIL_MAX * (shelter || 0) * (airF || 0);
}

// ---------- Pioggia troppo vecchia ----------
// Oltre 20 giorni dall'ultima pioggia utile il micelio smette di fruttificare: voto fortemente ridotto,
// ancora di più se fa più caldo della media del periodo (riscontro sul campo, ottobre 2026)
export const STALE_DAYS = 20;
export function staleFactor(lastRainDays, hot, limit = STALE_DAYS) {
  if (lastRainDays != null && lastRainDays <= limit) return 1;
  return hot ? 0.35 : 0.5;
}

// ---------- Vento che asciuga il bosco ----------
// Dopo la pioggia, i giorni di vento forte asciugano soprattutto i versanti rivolti verso il vento
// (tramontana da N -> versanti esposti a N). Carico per 8 settori di provenienza.
export const WIND_NAMES = ['Tramontana', 'Grecale', 'Levante', 'Scirocco', 'Ostro', 'Libeccio', 'Ponente', 'Maestrale'];
// Un giorno è ventoso se il vento sostenuto supera 25 km/h OPPURE le raffiche superano 35 km/h.
// Sui crinali i modelli smussano il vento sostenuto (Acquerino 12–14/10/2026: tramontana tesa sul posto,
// sostenuto 10–23 km/h nei modelli, raffiche ICON 41–71 km/h): le raffiche sono il segnale più fedele.
export const WIND_MIN_KMH = 25;
export const GUST_MIN_KMH = 35;
export function windLoad(d) {
  const w = d.wind ?? 0, g = d.gust ?? 0;
  if (w < WIND_MIN_KMH && g < GUST_MIN_KMH) return 0;
  return Math.min(2, Math.max((w - 20) / 10, (g - 25) / 20)); // 25 km/h o raffiche 35 = 0,5 · raffiche 65+ = 2
}
export function windLoads(days, fromIdx, toIdx) {
  const loads = new Array(8).fill(0);
  const events = [];
  for (let i = Math.max(0, fromIdx); i < toIdx && i < days.length; i++) {
    const d = days[i];
    if (d.windDir == null) continue;
    const l = windLoad(d);
    if (!l) continue;
    const k = Math.round(d.windDir / 45) % 8;
    loads[k] += l;
    events.push({ date: d.date, kmh: Math.round(Math.max(d.wind ?? 0, d.gust ?? 0)), k });
  }
  return { loads, events };
}

// Fattore 0,35–1 per un versante: pieno carico se rivolto verso il vento, metà per i versanti accanto
export function windFactor(aspect, slope, wind) {
  if (!wind || !wind.loads.some((x) => x > 0)) return 1;
  const k = Math.round(aspect / 45) % 8;
  const L = wind.loads;
  const load = L[k] + 0.5 * (L[(k + 1) % 8] + L[(k + 7) % 8]);
  const expo = clamp(slope / 12, 0, 1); // in piano il vento non "sceglie" un versante
  return 1 - Math.min(0.65, 0.3 * load) * expo;
}

// ---------- Punteggio finale ----------
// Prodotto pesato di fattori 0–1: basta un fattore debole per abbassare il voto,
// 100 solo quando luogo, suolo, timer e stagione sono tutti al massimo.
//   Luogo^1 × Suolo^1,2 × Timer'^0,8 × Stagione^0,5   (Timer' = 0,15 + 0,85 × timer)
export const SCORE_WEIGHTS = { luogo: 1, suolo: 1.2, timer: 0.8, stagione: 0.5 };
export function finalScore(luogo, suolo, timer, stagione) {
  const W = SCORE_WEIGHTS;
  return Math.pow(clamp(luogo, 0, 1), W.luogo)
    * Math.pow(clamp(suolo, 0, 1), W.suolo)
    * Math.pow(0.15 + 0.85 * clamp(timer, 0, 1), W.timer)
    * Math.pow(clamp(stagione, 0, 1), W.stagione);
}

// ---------- Bilancio idrico del suolo ----------
// "Secchio" di 50 mm (lettiera + primi cm di terreno): la pioggia lo riempie, l'evaporazione lo svuota,
// più lentamente quando è già asciutto. Si parte 40 giorni prima con il secchio a metà.
export const SOIL = { capacity: 50, kc: 0.8, spinup: 40, start: 0.4 };
export const SOIL_CLASSES = {
  umido:  { label: 'Suolo umido' },
  limite: { label: 'Suolo al limite' },
  secco:  { label: 'Suolo secco' },
};

// Fattore suolo continuo (0–1) dall'umidità: 70% e oltre = ideale, poi cala sempre più in fretta
export function moistureFactor(theta) {
  return piecewise(theta, [[0, 0.05], [0.2, 0.2], [0.35, 0.5], [0.5, 0.8], [0.7, 1]]);
}

export function soilMoisture(days, idx) {
  const cap = SOIL.capacity;
  let w = cap * SOIL.start;
  const from = Math.max(0, idx - SOIL.spinup);
  for (let i = from; i <= idx && i < days.length; i++) {
    const d = days[i];
    // senza dato di evaporazione: stima grezza dalla temperatura media
    const et = d.et0 ?? Math.max(0.3, 0.17 * ((d.tmax + d.tmin) / 2) - 0.6);
    w = Math.min(cap, w + (d.rain ?? 0));
    w = Math.max(0, w - SOIL.kc * et * Math.sqrt(w / cap));
  }
  return w / cap;
}

export function soilState(days, idx, rainTotal, s, learn) {
  const theta = soilMoisture(days, idx);
  let cls = theta >= 0.5 ? 'umido' : theta >= 0.3 ? 'limite' : 'secco';
  // soilShift < 0: nelle tue zone trovi anche con suolo più asciutto -> curva meno severa
  let factor = moistureFactor(theta - (learn?.soilShift || 0));
  // la regola dei 30 mm in 20 giorni resta valida: sotto soglia il suolo conta come secco
  if (rainTotal < s.rainMinMm) {
    cls = 'secco'; factor = Math.min(factor, moistureFactor(0.25));
    return { theta, cls, factor, label: `Suolo secco: meno di ${s.rainMinMm} mm in ${s.rainWindowDays} gg` };
  }
  return { theta, cls, factor, ...SOIL_CLASSES[cls] };
}

// Finestra di date consigliata (dall'ultimo episodio di pioggia valido)
export function bestDates(summary, forestKey, learn) {
  const e = summary.timerEpisode;
  if (!e) return null;
  const t = forestTimer(forestKey, learn);
  return { from: addDays(e.end, t.optStart), to: addDays(e.end, t.optEnd), firstPossible: addDays(e.end, t.start) };
}
