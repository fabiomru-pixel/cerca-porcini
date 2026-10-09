// Pioggia misurata dai pluviometri SIR Toscana.
// Fonte principale: lettura in diretta dal telefono tramite il servizio Cloudflare (SIR_PROXY_URL), solo per le
// stazioni vicine alla zona analizzata. Riserva: data/pluviometri.json (elenco stazioni + ultimi dati caricati).
// Per un punto: stazioni entro 12 km, scarto di quelle fuori scala rispetto alle vicine,
// mediana giornaliera delle 3 più vicine. Dove non ci sono stazioni resta la media dei modelli.
import { distKm } from './geo.js';
import { SIR_PROXY_URL } from './config.js';

const MAX_KM = 12;
const MAX_AGE_DAYS = 3;
const LIVE_TTL = 30 * 60 * 1000; // dati in diretta validi 30 minuti
const BATCH = 6;  // stazioni per richiesta: gruppi piccoli = arriva in tempo almeno una parte
const WAIT_MS = 15000; // il SIR risponde lento a Cloudflare: oltre questa attesa uso il file (e il servizio intanto mette in cache)
let baseP = null;
const live = new Map();          // id -> { t, r: { 'AAAA-MM-GG': mm } }

function loadBase() {
  if (!baseP) {
    baseP = (async () => {
      try {
        const r = await fetch('data/pluviometri.json', { cache: 'no-cache' });
        return r.ok ? await r.json() : null;
      } catch { return null; }
    })();
  }
  return baseP;
}

async function fetchLive(ids) {
  if (!SIR_PROXY_URL) return;
  const todo = ids.filter((id) => !(live.get(id)?.t > Date.now() - LIVE_TTL));
  const batches = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  await Promise.all(batches.map(async (b) => {
    try {
      const r = await fetch(`${SIR_PROXY_URL}?ids=${b.join(',')}`, { signal: AbortSignal.timeout(WAIT_MS) });
      if (!r.ok) return;
      const j = await r.json();
      for (const [id, days] of Object.entries(j.stations || {})) live.set(id, { t: Date.now(), r: days });
    } catch { /* servizio non raggiungibile: restano i dati del file */ }
  }));
}

// area = { lat, lon, km }: legge in diretta le stazioni dentro l'area (più il margine di 12 km)
export async function loadGauges(area) {
  const base = await loadBase();
  if (!base?.stations?.length) return null;
  let stations = base.stations;
  if (area) {
    stations = stations.filter((st) => distKm(area, st) <= area.km + MAX_KM);
    await fetchLive(stations.map((st) => st.id));
  }
  // il giorno in corso è parziale: per oggi resta la stima dei modelli
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
  const daySet = new Set(base.days);
  for (const st of stations) for (const d of Object.keys(live.get(st.id)?.r || {})) if (d < today) daySet.add(d);
  const days = [...daySet].sort();
  const merged = stations.map((st) => {
    const fromFile = {};
    base.days.forEach((d, i) => { fromFile[d] = st.r[i]; });
    const lv = live.get(st.id)?.r || {};
    return { ...st, r: days.map((d) => (lv[d] !== undefined ? lv[d] : fromFile[d] ?? null)) };
  });
  const nLive = stations.filter((st) => live.has(st.id)).length;
  const last = days[days.length - 1];
  if (!last || (Date.now() - new Date(last).getTime()) / 864e5 > MAX_AGE_DAYS + 1) return null; // dati vecchi: meglio i modelli
  return { days, stations: merged, live: nLive > 0, index: new Map(days.map((d, i) => [d, i])) };
}

const median = (xs) => {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

// Serie giornaliera misurata per un punto, o null se non ci sono stazioni affidabili vicine
export function gaugeSeries(g, lat, lon) {
  if (!g) return null;
  const p = { lat, lon };
  const near = g.stations
    .map((s) => ({ s, km: distKm(p, s) }))
    .filter((x) => x.km <= MAX_KM)
    .sort((a, b) => a.km - b.km)
    .slice(0, 6);
  if (!near.length) return null;
  // controllo di coerenza: un pluviometro con un totale lontanissimo da quello dei vicini è probabilmente guasto
  const tot = (s) => s.r.reduce((a, v) => a + (v ?? 0), 0);
  let valid = near;
  let outliers = [];
  if (near.length >= 3) {
    const M = median(near.map((x) => tot(x.s)));
    if (M > 10) {
      const ok = (x) => { const t = tot(x.s); return t >= 0.35 * M && t <= 2.8 * M; };
      outliers = near.filter((x) => !ok(x));
      valid = near.filter(ok);
    }
  }
  valid = valid.slice(0, 3);
  // una sola stazione: la uso solo se è davvero vicina
  if (!valid.length || (valid.length === 1 && valid[0].km > 6)) return null;
  const byDate = {};
  g.days.forEach((d, i) => { byDate[d] = median(valid.map((x) => x.s.r[i])); });
  return {
    byDate,
    stations: valid.map((x) => ({ n: x.s.n, km: Math.round(x.km * 10) / 10, el: x.s.el })),
    discarded: outliers.map((x) => x.s.n), // pluviometri fuori scala rispetto ai vicini (probabile guasto)
  };
}

// Sostituisce la pioggia stimata dai modelli con quella misurata, per i giorni coperti dai pluviometri
export function applyGauges(w, g) {
  const gs = gaugeSeries(g, w.lat, w.lon);
  if (!gs) { w.rainSrc = { type: 'modelli' }; return w; }
  let n = 0;
  for (const d of w.days) {
    const v = gs.byDate[d.date];
    if (v != null) { d.rainModel = d.rain; d.rain = v; n++; }
  }
  w.rainSrc = n ? { type: 'pluviometri', stations: gs.stations, days: n, from: g.days[0], to: g.days[g.days.length - 1] } : { type: 'modelli' };
  return w;
}
