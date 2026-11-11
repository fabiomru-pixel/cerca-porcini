// patch: la pioggia che arriva su un timer già avviato può essere rinforzo, nuovo timer o stop per saturazione
const fs = require('fs');
process.chdir(__dirname + '/..');
const rep = (f, a, b) => { let s = fs.readFileSync(f, 'utf8'); if (!s.includes(a)) throw new Error(f + ': ' + a.slice(0, 70)); fs.writeFileSync(f, s.replace(a, b)); };
const E = 'js/engine.js';

rep(E, `export function summarize(days, dateStr, s) {`, `// ---------- Seconda pioggia su un timer già avviato ----------
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

export function summarize(days, dateStr, s) {`);

rep(E, `  const tr = timerRain(days, timerFrom, idx, s.rainEventMm);
  if (tr) {
    const daysSince = idx - tr.timerIdx;
    let sc = timerScore(daysSince, t);`, `  const tr = timerState(days, timerFrom, idx, s, forestKey);
  if (tr) {
    const daysSince = idx - tr.timerIdx;
    // rinforzo: la seconda pioggia allunga la finestra di qualche giorno
    const tx = tr.ext ? { ...t, optEnd: t.optEnd + tr.ext, end: t.end + tr.ext } : t;
    let sc = timerScore(daysSince, tx);`);
rep(E, `    weakRain: best.weak, // pioggia sotto i 15 mm: voto −20%`, `    weakRain: best.weak, // pioggia sotto i 15 mm: voto −20%
    rainEvent: tr?.event || null, // ultima pioggia arrivata sul timer: nuovo / rinforzo / saturazione
    sat: tr?.sat && idx - tr.sat.endIdx <= SECOND_RAIN.satDays ? { ...tr.sat, idx } : null,`);

// analysis: la saturazione dipende dalla pendenza della cella
const A = 'js/analysis.js';
rep(A, `const combine = (place, tm, season, bonus, hot, sh) => finalScore(Math.min(1, place * bonus), microSoil(tm.soil.factor, sh, tm.air?.f), tm.timer, season)
  * staleFactor(tm.lastRainDays, hot, tm.staleDays) * (tm.weakRain ? WEAK_RAIN_FACTOR : 1);`, `// + terreno saturo da una seconda pioggia (meno grave sulle pendenze che drenano)
const combine = (place, tm, season, bonus, hot, sh, slope) => finalScore(Math.min(1, place * bonus), microSoil(tm.soil.factor, sh, tm.air?.f), tm.timer, season)
  * staleFactor(tm.lastRainDays, hot, tm.staleDays) * (tm.weakRain ? WEAK_RAIN_FACTOR : 1)
  * (tm.sat ? saturationFactor(tm.sat, tm.sat.idx, slope) : 1);`);
rep(A, `  WEAK_RAIN_FACTOR, microSoil, shelterOf,`, `  WEAK_RAIN_FACTOR, microSoil, shelterOf, saturationFactor,`);
let a = fs.readFileSync(A, 'utf8');
const n0 = (a.match(/combine\(/g) || []).length;
a = a.replace(`const fin = combine(pl.score, tm, g.weight, bonus, hot, sh);`, `const fin = combine(pl.score, tm, g.weight, bonus, hot, sh, slope);`); // scansione larga
a = a.replace(`const fin = combine(pl.score, tm, g.weight, bonus, hot, shelterOf(wet?.m, aspect, slope));`, `const fin = combine(pl.score, tm, g.weight, bonus, hot, shelterOf(wet?.m, aspect, slope), slope);`);
a = a.replace(`        const fin = combine(pl.score, tm, g.weight, bonus, hot, sh);`, `        const fin = combine(pl.score, tm, g.weight, bonus, hot, sh, c.slope);`);
a = a.replace(`        const fin = combine(pl.score, tm, g.weight, fBonus, hot, fSh);`, `        const fin = combine(pl.score, tm, g.weight, fBonus, hot, fSh, slope);`);
fs.writeFileSync(A, a);
console.log('combine calls', n0, 'with slope', (a.match(/combine\([^)]*slope\)|combine\([^;]*, c\.slope\)/g) || []).length);
// dati per la scheda
a = fs.readFileSync(A, 'utf8');
const k = 'lastRainDays: tm.lastRainDays, lastRainDate: tm.lastRainDate, staleDays: tm.staleDays,';
const cnt = a.split(k).length - 1;
a = a.split(k).join(k + ' rainEvent: tm.rainEvent, saturated: !!tm.sat,');
fs.writeFileSync(A, a);
console.log('rainEvent fields', cnt);

// finds: pioggia madre con la stessa regola (per quello che l'app impara)
const F = 'js/finds.js';
rep(F, `import { rainEpisodes, timerRain, RAIN_FULL_MM,`, `import { rainEpisodes, timerRain, timerState, RAIN_FULL_MM,`);
rep(F, `  const tr = timerRain(w.days, idx - s.rainWindowDays, idx - MIN_FRUIT_DAYS, s.rainEventMm);`, `  const tr = timerState(w.days, idx - s.rainWindowDays, idx - MIN_FRUIT_DAYS, s, place.forestKey || forestByElevation(place.elevation).key);`);
rep(F, `export const SNAPSHOT_VER = 5;`, `// 6 = seconda pioggia: rinforzo / nuovo timer / saturazione (timerState)
export const SNAPSHOT_VER = 6;`);

// scheda spot: riga nei Dettagli
const P = 'js/app.js';
rep(P, `    s.wind ? windText(s.wind) : '',`, `    s.rainEvent ? rainEventText(s.rainEvent, s.saturated) : '',
    s.wind ? windText(s.wind) : '',`);
rep(P, `// Microclima umido vicino a fossi e impluvi`, `// Ultima pioggia arrivata su un timer già avviato
function rainEventText(e, saturated) {
  const d = itDate(e.date);
  if (e.type === 'nuovo') return \`Pioggia del \${d} (\${e.mm} mm) su suolo ormai secco (\${e.theta}%): <b>nuovo timer</b>\`;
  if (e.type === 'saturazione') return \`<span style="color:var(--warn)">Pioggia del \${d} (\${e.mm} mm) su suolo già saturo (\${e.theta}%)\${saturated ? ': voto ridotto per qualche giorno' : ''}</span>\`;
  return \`Pioggia del \${d} (\${e.mm} mm) su suolo ancora umido (\${e.theta}%): <b>rinforzo</b>, finestra più lunga\`;
}
// Microclima umido vicino a fossi e impluvi`);
console.log('ok');
