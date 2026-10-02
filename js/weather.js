// Meteo da Open-Meteo (gratuito, senza chiave)
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const DAILY = 'temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,wind_direction_10m_dominant,et0_fao_evapotranspiration';

function toDays(d) {
  return d.time.map((t, i) => ({
    date: t,
    tmax: d.temperature_2m_max[i],
    tmin: d.temperature_2m_min[i],
    rain: d.precipitation_sum[i] ?? 0,
    wind: d.wind_speed_10m_max[i],
    windDir: d.wind_direction_10m_dominant[i],
    et0: d.et0_fao_evapotranspiration?.[i] ?? null, // evaporazione potenziale (mm/giorno)
  }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Media di 3 modelli (ECMWF, ICON-EU, GFS). Il "best_match" di Open-Meteo, confrontato con 18
// pluviometri SIR in Toscana (settembre 2026), sbagliava la pioggia anche di 3–5 volte in entrambe
// le direzioni; la media di questi tre modelli era la più vicina al dato misurato.
export const ENSEMBLE = ['ecmwf_ifs025', 'icon_eu', 'gfs_seamless'];
const mean = (xs) => { const v = xs.filter((x) => x != null && !Number.isNaN(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const meanDir = (xs) => { // media di direzioni (gradi) come vettori
  const v = xs.filter((x) => x != null); if (!v.length) return null;
  const s = v.reduce((a, d) => a + Math.sin((d * Math.PI) / 180), 0), c = v.reduce((a, d) => a + Math.cos((d * Math.PI) / 180), 0);
  return ((Math.atan2(s, c) * 180) / Math.PI + 360) % 360;
};
function toDaysEnsemble(d) {
  const g = (name, i) => ENSEMBLE.map((m) => d[`${name}_${m}`]?.[i] ?? null);
  return d.time.map((t, i) => ({
    date: t,
    tmax: mean(g('temperature_2m_max', i)),
    tmin: mean(g('temperature_2m_min', i)),
    rain: mean(g('precipitation_sum', i)) ?? 0,
    wind: mean(g('wind_speed_10m_max', i)),
    windDir: meanDir(g('wind_direction_10m_dominant', i)),
    et0: mean(g('et0_fao_evapotranspiration', i)),
    rainModels: g('precipitation_sum', i), // per mostrare l'accordo tra i modelli
  }));
}

// Memoria del meteo per 3 ore: rifare l'analisi nella stessa zona non riscarica tutto
const CACHE_MS = 3 * 3600 * 1000;
const wxCache = new Map();
const cacheKey = (p, pastDays, forecastDays) => `${p.lat.toFixed(3)},${p.lon.toFixed(3)}|${pastDays}|${forecastDays}|${new Date().toLocaleDateString('sv-SE')}`;

// Dati giornalieri per più punti (una richiesta ogni 40 punti).
// Il servizio gratuito ha un limite di richieste al minuto: se risponde 429 aspetto e riprovo.
export async function fetchDaily(points, { pastDays = 30, forecastDays = 16, onWait } = {}) {
  const out = new Array(points.length);
  const todo = [];
  points.forEach((p, k) => {
    const hit = wxCache.get(cacheKey(p, pastDays, forecastDays));
    if (hit && Date.now() - hit.at < CACHE_MS) out[k] = { lat: p.lat, lon: p.lon, elevation: hit.elevation, days: hit.days.map((d) => ({ ...d })) };
    else todo.push(k);
  });
  for (let i = 0; i < todo.length; i += 40) {
    const idxs = todo.slice(i, i + 40);
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
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(`${FORECAST}?${p}`);
      if (res.status !== 429 || attempt >= 4) break;
      const wait = 20 * (attempt + 1);
      onWait?.(wait);
      await sleep(wait * 1000);
    }
    if (!res.ok) throw new Error(res.status === 429 ? 'Open-Meteo: troppe richieste in poco tempo, riprova tra qualche minuto' : `Open-Meteo: ${res.status}`);
    let j = await res.json();
    if (!Array.isArray(j)) j = [j];
    j.forEach((r, n) => {
      const days = toDaysEnsemble(r.daily);
      const k = idxs[n];
      wxCache.set(cacheKey(points[k], pastDays, forecastDays), { at: Date.now(), elevation: r.elevation, days });
      out[k] = { lat: chunk[n].lat, lon: chunk[n].lon, elevation: r.elevation, days: days.map((d) => ({ ...d })) };
    });
  }
  return out;
}

// Dati giornalieri storici (archivio Open-Meteo, dal 1940) per un punto e un intervallo di date
export async function fetchDailyArchive(lat, lon, startDate, endDate) {
  const p = new URLSearchParams({
    latitude: lat.toFixed(4), longitude: lon.toFixed(4), daily: DAILY,
    start_date: startDate, end_date: endDate, timezone: 'Europe/Rome',
  });
  const res = await fetch(`${ARCHIVE}?${p}`);
  if (!res.ok) throw new Error(`Open-Meteo archivio: ${res.status}`);
  const j = await res.json();
  return { lat, lon, elevation: j.elevation, days: toDays(j.daily) };
}

// Temperatura oraria in un punto e in un istante (per le fungaie salvate)
export async function temperatureAt(lat, lon, when) {
  const d = new Date(when);
  const ageDays = (Date.now() - d.getTime()) / 864e5;
  const date = d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
  const hour = Number(d.toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/Rome' })) % 24;
  let url;
  const base = { latitude: lat.toFixed(4), longitude: lon.toFixed(4), hourly: 'temperature_2m,relative_humidity_2m', timezone: 'Europe/Rome' };
  if (ageDays < 85) url = `${FORECAST}?${new URLSearchParams({ ...base, start_date: date, end_date: date })}`;
  else url = `${ARCHIVE}?${new URLSearchParams({ ...base, start_date: date, end_date: date })}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo: ${res.status}`);
  const j = await res.json();
  return { temp: j.hourly.temperature_2m[hour], humidity: j.hourly.relative_humidity_2m[hour] };
}
