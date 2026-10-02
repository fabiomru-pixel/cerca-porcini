// Pioggia misurata dai pluviometri SIR Toscana (file aggiornato ogni notte da GitHub Actions).
// Per un punto: stazioni entro 12 km, scarto di quelle fuori scala rispetto alle vicine,
// mediana giornaliera delle 3 più vicine. Dove non ci sono stazioni resta la media dei modelli.
import { distKm } from './geo.js';

const MAX_KM = 12;
const MAX_AGE_DAYS = 3;
let gp = null;

export function loadGauges() {
  if (gp) return gp;
  gp = (async () => {
    try {
      const r = await fetch('data/pluviometri.json', { cache: 'no-cache' });
      if (!r.ok) return null;
      const g = await r.json();
      if ((Date.now() - new Date(g.updated).getTime()) / 864e5 > MAX_AGE_DAYS) return null; // dati vecchi: meglio i modelli
      g.index = new Map(g.days.map((d, i) => [d, i]));
      return g;
    } catch { return null; }
  })();
  return gp;
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
