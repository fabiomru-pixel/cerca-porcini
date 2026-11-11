// patch: spot non più ammassati sul bordo del raggio
// 1) le 600 celle migliori della scansione larga vengono ricalcolate con la pioggia dei pluviometri vicini a
//    ciascuna (la griglia meteo ha punti ogni 16 km e penalizzava il bosco vicino alla partenza in pianura)
// 2) a parità di qualità vince il più vicino (al massimo -3% al bordo del raggio): l'anello esterno ha molte più
//    celle del centro e, con tanti posti equivalenti, vinceva solo perché ne aveva di più
const fs = require('fs');
process.chdir(__dirname + '/..');
const A = 'js/analysis.js';
let s = fs.readFileSync(A, 'utf8');
const rep = (a, b) => { if (!s.includes(a)) throw new Error(a.slice(0, 80)); s = s.replace(a, () => b); };

// via il gancio di prova
s = s.replace(/  if \(globalThis\.__cpDebug\)[^\n]*\n/, '');

rep(`  onStep('Seleziono le aree più promettenti…', 0.66);
  cands.sort((a, b) => b.fin - a.fin);`, `  onStep('Seleziono le aree più promettenti…', 0.66);
  cands.sort((a, b) => b.fin - a.fin);
  // pioggia e suolo delle celle migliori dai pluviometri vicini a ciascuna, non dal punto meteo della griglia
  for (const c of cands.slice(0, 600)) {
    const w = atPoint(nearestWeather(grid, byIJ, c.lat, c.lon, center), c.lat, c.lon);
    const tm2 = evalTiming(w, date, s, c.fk, c.elevation, learn);
    const before = combine(c.pl.score, c.tm, c.g.weight, 1, hot, 0, c.slope);
    if (before > 0) c.fin *= combine(c.pl.score, tm2, c.g.weight, 1, hot, 0, c.slope) / before;
  }
  // a parità di qualità vince il più vicino: al massimo -3% al bordo del raggio (solo per l'ordine, non per il voto)
  const nearKey = (c) => c.fin * (1 - 0.03 * Math.min(1, distKm(center, c) / radius));
  cands.sort((a, b) => nearKey(b) - nearKey(a));`);
rep(`  refined.sort((a, b) => b.fin - a.fin);
  const picked = [];`, `  refined.sort((a, b) => nearKey(b) - nearKey(a));
  const picked = [];`);
// ordine finale degli spot: stesso criterio (il voto mostrato resta quello vero)
rep(`    .sort((a, b) => b.score - a.score);`, `    .sort((a, b) => (b.score * (1 - 0.03 * Math.min(1, distKm(center, b) / radius))) - (a.score * (1 - 0.03 * Math.min(1, distKm(center, a) / radius))));`);
fs.writeFileSync(A, s);
console.log('ok', s.includes('__cpDebug') ? 'GANCIO ANCORA PRESENTE' : 'gancio rimosso');
