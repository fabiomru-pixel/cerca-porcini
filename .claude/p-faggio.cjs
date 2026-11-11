// patch: finestra della pioggia e soglia "pioggia vecchia" allungate per i faggi (timer diesel fino a 24 gg)
const fs = require('fs');
process.chdir(__dirname + '/..');
const rep = (f, a, b) => { let s = fs.readFileSync(f, 'utf8'); if (!s.includes(a)) throw new Error(f + ': ' + a.slice(0, 70)); fs.writeFileSync(f, s.replace(a, b)); };
const E = 'js/engine.js';
rep(E, `  const t = forestTimer(forestKey, learn);
  const dT = cellElev != null && wp.elevation != null ? ((cellElev - wp.elevation) * s.gradient) / 100 : 0;
`, `  const t = forestTimer(forestKey, learn);
  const dT = cellElev != null && wp.elevation != null ? ((cellElev - wp.elevation) * s.gradient) / 100 : 0;
  // i faggi (timer "diesel") fruttificano fino a ~24 giorni dopo la pioggia: la pioggia del timer si cerca
  // fino a quel giorno, e la penalità "pioggia vecchia" parte solo dopo. Querce e castagni restano a 20.
  const longTimer = forestKey === 'faggio';
  const timerFrom = longTimer ? Math.min(from, idx - t.end) : from;
  const staleDays = longTimer ? Math.max(STALE_DAYS, t.end) : STALE_DAYS;
`);
rep(E, `  const tr = timerRain(days, from, idx, s.rainEventMm);
  if (tr) {`, `  const tr = timerRain(days, timerFrom, idx, s.rainEventMm);
  if (tr) {`);
rep(E, `    weakRain: best.weak, // pioggia sotto i 15 mm: voto −20%`, `    weakRain: best.weak, // pioggia sotto i 15 mm: voto −20%
    staleDays, // oltre questi giorni dall'ultima pioggia il voto si riduce (20; faggi fino a fine timer)`);
rep(E, `export function staleFactor(lastRainDays, hot) {
  if (lastRainDays != null && lastRainDays <= STALE_DAYS) return 1;`, `export function staleFactor(lastRainDays, hot, limit = STALE_DAYS) {
  if (lastRainDays != null && lastRainDays <= limit) return 1;`);
rep('js/analysis.js', `  * staleFactor(tm.lastRainDays, hot) * (tm.weakRain ? WEAK_RAIN_FACTOR : 1);`, `  * staleFactor(tm.lastRainDays, hot, tm.staleDays) * (tm.weakRain ? WEAK_RAIN_FACTOR : 1);`);
console.log('ok');
