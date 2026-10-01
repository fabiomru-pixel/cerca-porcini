// Clima "normale" del periodo e situazione del bosco (secco/caldo, umido/fresco, intermedia)
import { kv } from './db.js';
import { fetchDailyArchive } from './weather.js';

// Tabella di riferimento (medie annue di pianura) -> scarti per soglia "elevata" e "massime anomale"
export const ZONES = {
  nord:   { label: 'Nord',          annual: 14,   high: 16.5, maxAnom: 25.5 },
  centro: { label: 'Centro',        annual: 16.5, high: 19.5, maxAnom: 27.5 },
  sud:    { label: 'Sud e Isole',   annual: 20,   high: 23.5, maxAnom: 29.5 },
};
export const zoneOf = (lat) => (lat > 44.2 ? 'nord' : lat >= 41.5 ? 'centro' : 'sud');

// Medie mensili di pianura (°C), usate solo se l'archivio storico non risponde
const MONTHLY = {
  nord:   [2.9, 4.8, 9.3, 12.9, 17.6, 21.6, 24.4, 23.6, 19.4, 13.8, 8.1, 3.6],    // Milano
  centro: [6.5, 7.8, 10.6, 13.5, 17.8, 21.8, 24.9, 24.6, 20.8, 15.9, 10.6, 7.2],  // Firenze
  sud:    [8.5, 9.2, 11.6, 14.6, 19.2, 23.6, 26.5, 26.4, 22.3, 17.6, 12.9, 9.6],  // Foggia
};

const doy = (d) => {
  const t = new Date(d + 'T12:00:00');
  return Math.round((t - new Date(t.getFullYear(), 0, 1)) / 864e5);
};

// Normale del periodo (±15 giorni) dagli ultimi 10 anni nel punto di partenza; cache per zona di ~10 km
async function localNormal(lat, lon, dateStr) {
  const key = `clim:${lat.toFixed(1)},${lon.toFixed(1)}`;
  let c = await kv.get(key);
  if (!c) {
    const y = new Date().getFullYear() - 1;
    const w = await fetchDailyArchive(lat, lon, `${y - 9}-01-01`, `${y}-12-31`);
    // media giornaliera per giorno dell'anno
    const sum = new Array(367).fill(0), sumMax = new Array(367).fill(0), n = new Array(367).fill(0);
    for (const d of w.days) {
      if (d.tmax == null || d.tmin == null) continue;
      const k = doy(d.date);
      sum[k] += (d.tmax + d.tmin) / 2; sumMax[k] += d.tmax; n[k]++;
    }
    c = { mean: sum.map((s, i) => (n[i] ? s / n[i] : null)), max: sumMax.map((s, i) => (n[i] ? s / n[i] : null)), years: 10 };
    await kv.set(key, c);
  }
  const k0 = doy(dateStr);
  let m = 0, mx = 0, cnt = 0;
  for (let k = k0 - 15; k <= k0 + 15; k++) {
    const kk = ((k % 366) + 366) % 366;
    if (c.mean[kk] == null) continue;
    m += c.mean[kk]; mx += c.max[kk]; cnt++;
  }
  if (!cnt) throw new Error('clima non disponibile');
  return { mean: m / cnt, max: mx / cnt, source: 'archivio 10 anni' };
}

function tableNormal(zone, dateStr, valleyElev, gradient) {
  const d = new Date(dateStr + 'T12:00:00');
  const m = d.getMonth(), f = (d.getDate() - 15) / 30; // interpolazione tra mesi
  const arr = MONTHLY[zone];
  const a = arr[m], b = f >= 0 ? arr[(m + 1) % 12] : arr[(m + 11) % 12];
  const mean = a + (b - a) * Math.abs(f) - (Math.max(0, valleyElev - 50) * gradient) / 100;
  return { mean, max: null, source: 'medie mensili di riferimento' };
}

// Soglie del periodo per la posizione di partenza
export async function climateFor(lat, lon, dateStr, valleyElev, gradient) {
  const zone = zoneOf(lat);
  const Z = ZONES[zone];
  let n;
  try { n = await localNormal(lat, lon, dateStr); } catch { n = tableNormal(zone, dateStr, valleyElev, gradient); }
  return {
    zone, zoneLabel: Z.label, source: n.source,
    normal: n.mean,
    low: n.mean + 0.5,                         // media <= normale: medio-bassa / bassa
    high: n.mean + (Z.high - Z.annual),        // media elevata
    maxAnom: n.mean + (Z.maxAnom - Z.annual),  // massime anomale
  };
}

export function tempClass(summary, clim) {
  return {
    high: summary.meanT > clim.high,
    maxAnom: summary.meanMax > clim.maxAnom,
    low: summary.meanT <= clim.low,
  };
}

// Situazione per uno spot: dipende dalla pioggia caduta nella sua zona e dalla temperatura in valle
export const RAIN_SCARCE = 30, RAIN_ABUNDANT = 60;
export function regimeOf(rainTotal, tc) {
  if (rainTotal < RAIN_SCARCE || tc.high || tc.maxAnom) return 'A';
  if (rainTotal >= RAIN_ABUNDANT && tc.low) return 'B';
  return 'C';
}

export const REGIMES = {
  A: { label: 'Secco o caldo', hint: 'premio versanti Nord–Nord-Est su terreno piano o in falsopiano' },
  B: { label: 'Umido e fresco', hint: 'premio versanti Sud–Sud-Est con pendenza media (10–25°)' },
  C: { label: 'Intermedia', hint: 'nessuna esposizione privilegiata, pianori preferiti' },
};
