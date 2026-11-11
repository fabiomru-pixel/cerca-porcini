// patch: il vento conta anche con le raffiche (ICON-EU), non solo con il vento sostenuto
const fs = require('fs');
process.chdir(__dirname + '/..');
const rep = (f, a, b) => { let s = fs.readFileSync(f, 'utf8'); if (!s.includes(a)) throw new Error(f + ': ' + a.slice(0, 70)); fs.writeFileSync(f, s.replace(a, b)); };
const W = 'js/weather.js';
rep(W, `relative_humidity_2m_mean,wind_speed_10m_mean';`, `relative_humidity_2m_mean,wind_speed_10m_mean,wind_gusts_10m_max';`);
rep(W, `    windMean: d.wind_speed_10m_mean?.[i] ?? null,   // vento medio della giornata (km/h)\n`, `    windMean: d.wind_speed_10m_mean?.[i] ?? null,   // vento medio della giornata (km/h)\n    gust: d.wind_gusts_10m_max?.[i] ?? null,        // raffica massima (km/h)\n`);
rep(W, `    windMean: mean(g('wind_speed_10m_mean', i)),\n`, `    windMean: mean(g('wind_speed_10m_mean', i)),
    // raffiche: ICON-EU (7 km) segue meglio i crinali; gli altri modelli smussano molto. Riserva: la più alta dei tre
    gust: d[\`wind_gusts_10m_max_icon_eu\`]?.[i] ?? (g('wind_gusts_10m_max', i).filter((x) => x != null).sort((a, b) => b - a)[0] ?? null),
`);
const E = 'js/engine.js';
rep(E, `export const WIND_MIN_KMH = 30; // raffica media massima giornaliera a 10 m da cui il vento conta`, `// Un giorno è ventoso se il vento sostenuto supera 25 km/h OPPURE le raffiche superano 35 km/h.
// Sui crinali i modelli smussano il vento sostenuto (Acquerino 12–14/10/2026: tramontana tesa sul posto,
// sostenuto 10–23 km/h nei modelli, raffiche ICON 41–71 km/h): le raffiche sono il segnale più fedele.
export const WIND_MIN_KMH = 25;
export const GUST_MIN_KMH = 35;
export function windLoad(d) {
  const w = d.wind ?? 0, g = d.gust ?? 0;
  if (w < WIND_MIN_KMH && g < GUST_MIN_KMH) return 0;
  return Math.min(2, Math.max((w - 20) / 10, (g - 25) / 20)); // 25 km/h o raffiche 35 = 0,5 · raffiche 65+ = 2
}`);
rep(E, `    if (d.wind == null || d.windDir == null || d.wind < WIND_MIN_KMH) continue;
    const k = Math.round(d.windDir / 45) % 8;
    const l = Math.min(2, (d.wind - 25) / 10); // 30 km/h = 0,5 · 35 = 1 · 45+ = 2
    loads[k] += l;
    events.push({ date: d.date, kmh: Math.round(d.wind), k });`, `    if (d.windDir == null) continue;
    const l = windLoad(d);
    if (!l) continue;
    const k = Math.round(d.windDir / 45) % 8;
    loads[k] += l;
    events.push({ date: d.date, kmh: Math.round(Math.max(d.wind ?? 0, d.gust ?? 0)), k });`);
// fungaie: "vento forte nei 7 giorni prima" con la stessa regola
const F = 'js/finds.js';
rep(F, `    if ((d.wind ?? 0) > maxWind) { maxWind = d.wind; maxWindDate = d.date; }`, `    const wv = Math.max(d.wind ?? 0, d.gust ?? 0);
    if (wv > maxWind) { maxWind = wv; maxWindDate = d.date; }
    if (windLoad(d) > 0) windy = true;`);
rep(F, `  let maxT = -99, maxTDate = null, maxWind = 0, maxWindDate = null;`, `  let maxT = -99, maxTDate = null, maxWind = 0, maxWindDate = null, windy = false;`);
rep(F, `  const wind = maxWind >= 30;`, `  const wind = windy;`);
rep(F, `import { rainEpisodes, timerRain, RAIN_FULL_MM, airMoisture,`, `import { rainEpisodes, timerRain, RAIN_FULL_MM, airMoisture, windLoad,`);
// scheda
rep('js/app.js', "${x.name} ${x.days} g (max ${x.max} km/h)", "${x.name} ${x.days} g (raffiche fino a ${x.max} km/h)");
rep('js/app.js', "adv.wind && `vento forte (${adv.maxWind} km/h il ${itDate(adv.maxWindDate)})`", "adv.wind && `vento forte (raffiche ${adv.maxWind} km/h il ${itDate(adv.maxWindDate)})`");
console.log('ok');
