// patch: meteo scaricato a blocchi piccoli in parallelo, con tempo massimo, nuovo tentativo e avanzamento visibile
const fs = require('fs');
process.chdir(__dirname + '/..');
const rep = (f, a, b) => { let s = fs.readFileSync(f, 'utf8'); if (!s.includes(a)) throw new Error(f + ': ' + a.slice(0, 70)); fs.writeFileSync(f, s.replace(a, b)); };
const W = 'js/weather.js';
let s = fs.readFileSync(W, 'utf8');
const i = s.indexOf('// Dati giornalieri per più punti (una richiesta ogni 40 punti).');
const j = s.indexOf('// Dati giornalieri storici');
if (i < 0 || j < 0) throw new Error('fetchDaily');
s = s.slice(0, i) + `// Dati giornalieri per più punti: blocchi da 15 punti, 4 richieste insieme.
// Open-Meteo a volte risponde lentissimo (16/10/2026: 110 s per un blocco da 40 punti): a blocchi piccoli in
// parallelo l'attesa si divide, e ogni richiesta ha un tempo massimo con un nuovo tentativo.
// Il servizio gratuito ha un limite di richieste al minuto: se risponde 429 (o 502/503/504) aspetto e riprovo.
const CHUNK = 15, PARALLEL = 4, TIMEOUT_MS = 90000;
export async function fetchDaily(points, { pastDays = 30, forecastDays = 16, onWait, onProgress } = {}) {
  const out = new Array(points.length);
  const todo = [];
  points.forEach((p, k) => {
    const hit = wxCache.get(cacheKey(p, pastDays, forecastDays));
    if (hit && Date.now() - hit.at < CACHE_MS) out[k] = { lat: p.lat, lon: p.lon, elevation: hit.elevation, days: hit.days.map((d) => ({ ...d })) };
    else todo.push(k);
  });
  const chunks = [];
  for (let i = 0; i < todo.length; i += CHUNK) chunks.push(todo.slice(i, i + CHUNK));
  let done = points.length - todo.length;
  onProgress?.(done, points.length);

  const getChunk = async (idxs) => {
    const chunk = idxs.map((k) => points[k]);
    const p = new URLSearchParams({
      latitude: chunk.map((c) => c.lat.toFixed(4)).join(','),
      longitude: chunk.map((c) => c.lon.toFixed(4)).join(','),
      daily: DAILY,
      models: ENSEMBLE.join(','),
      past_days: pastDays,
      forecast_days: forecastDays,
      timezone: 'Europe/Rome',
    });
    let res = null;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(\`\${FORECAST}?\${p}\`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (e) {
        // tempo scaduto o rete assente: un nuovo tentativo, poi errore chiaro
        if (attempt >= 1) throw new Error(e.name === 'TimeoutError' ? 'Open-Meteo non risponde (servizio molto lento): riprova tra qualche minuto' : 'Connessione al servizio meteo non riuscita');
        onWait?.(5); await sleep(5000); continue;
      }
      if (![429, 502, 503, 504].includes(res.status) || attempt >= 4) break;
      const wait = 20 * (attempt + 1);
      onWait?.(wait);
      await sleep(wait * 1000);
    }
    if (!res.ok) throw new Error(res.status === 429 ? 'Open-Meteo: troppe richieste in poco tempo, riprova tra qualche minuto' : res.status >= 502 ? 'Open-Meteo è sovraccarico in questo momento: riprova tra qualche minuto' : \`Open-Meteo: \${res.status}\`);
    let jj = await res.json();
    if (!Array.isArray(jj)) jj = [jj];
    jj.forEach((r, n) => {
      const days = toDaysEnsemble(r.daily);
      const k = idxs[n];
      wxCache.set(cacheKey(points[k], pastDays, forecastDays), { at: Date.now(), elevation: r.elevation, days });
      out[k] = { lat: chunk[n].lat, lon: chunk[n].lon, elevation: r.elevation, days: days.map((d) => ({ ...d })) };
    });
    done += idxs.length;
    onProgress?.(done, points.length);
  };

  let next = 0;
  await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks.length) }, async () => {
    while (next < chunks.length) await getChunk(chunks[next++]);
  }));
  return out;
}

` + s.slice(j);
fs.writeFileSync(W, s);

const A = 'js/analysis.js';
rep(A, `  const wx = await fetchDaily(grid.pts, { pastDays, forecastDays: fDays, onWait });`, `  const wx = await fetchDaily(grid.pts, { pastDays, forecastDays: fDays, onWait,
    onProgress: (d, n) => onStep(\`Scarico il meteo in quota… \${d}/\${n} punti\`, 0.45 + 0.1 * (d / Math.max(1, n))) });`);
rep(A, `await fetchDaily(need.map((c) => ({ lat: c.lat, lon: c.lon })), { pastDays, forecastDays: fDays, onWait })`, `await fetchDaily(need.map((c) => ({ lat: c.lat, lon: c.lon })), { pastDays, forecastDays: fDays, onWait,
      onProgress: (d, n) => onStep(\`Scarico il meteo puntuale delle aree migliori… \${d}/\${n}\`, 0.66) })`);
// il messaggio di attesa ora vale anche per i nuovi tentativi brevi
rep(A, "const onWait = (sec) => onStep(`Il servizio meteo chiede una pausa: riprovo tra ${sec} secondi…`, 0.45);", "const onWait = (sec) => onStep(`Il servizio meteo è lento o chiede una pausa: riprovo tra ${sec} secondi…`, 0.45);");
console.log('ok');
