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

// Dati giornalieri per più punti (una richiesta ogni 40 punti).
// Il servizio gratuito ha un limite di richieste al minuto: se risponde 429 aspetto e riprovo.
export async function fetchDaily(points, { pastDays = 30, forecastDays = 16, onWait } = {}) {
  const out = [];
  for (let i = 0; i < points.length; i += 40) {
    const chunk = points.slice(i, i + 40);
    const p = new URLSearchParams({
      latitude: chunk.map((c) => c.lat.toFixed(4)).join(','),
      longitude: chunk.map((c) => c.lon.toFixed(4)).join(','),
      daily: DAILY,
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
    j.forEach((r, k) => out.push({ lat: chunk[k].lat, lon: chunk[k].lon, elevation: r.elevation, days: toDays(r.daily) }));
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
