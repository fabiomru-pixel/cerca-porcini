// Raggiungibilità: strada percorribile in auto più vicina (OSRM / OpenStreetMap, gratuito)
// e stima del tempo a piedi dalla strada allo spot (distanza × tortuosità + dislivello).
import { kv } from './db.js';

// due server pubblici OSRM, usati a turno con almeno 1 secondo tra le richieste allo stesso server
const SERVERS = ['https://router.project-osrm.org', 'https://routing.openstreetmap.de/routed-car'];
const lastCall = SERVERS.map(() => 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let rr = 0;

async function osrmNearest(lat, lon) {
  for (let attempt = 0; attempt < SERVERS.length * 2; attempt++) {
    const i = rr++ % SERVERS.length;
    const wait = lastCall[i] + 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall[i] = Date.now();
    try {
      const r = await fetch(`${SERVERS[i]}/nearest/v1/driving/${lon.toFixed(6)},${lat.toFixed(6)}?number=1`, { signal: AbortSignal.timeout(12000) });
      if (!r.ok) continue;
      const j = await r.json();
      const w = j.waypoints?.[0];
      if (j.code === 'Ok' && w) return { lon: w.location[0], lat: w.location[1], distM: Math.round(w.distance), name: w.name || '' };
    } catch { /* provo l'altro server */ }
  }
  return null;
}

// strada più vicina (in memoria permanente: le strade non cambiano da un giorno all'altro)
export async function nearestRoad(lat, lon) {
  const key = `road:${lat.toFixed(4)},${lon.toFixed(4)}`;
  try { const c = await kv.get(key); if (c) return c; } catch { /* nessuna memoria */ }
  const r = await osrmNearest(lat, lon);
  if (r) { try { await kv.set(key, r); } catch { /* pazienza */ } }
  return r;
}

// minuti a piedi: 4,5 km/h su un percorso ~35% più lungo della linea d'aria,
// +1 minuto ogni 6,7 m di salita (400 m/h) e ogni 13 m di discesa (800 m/h)
export function walkMinutes(distM, ascentM) {
  const flat = ((distM * 1.35) / 4500) * 60;
  const up = Math.max(0, ascentM) / 400 * 60;
  const down = Math.max(0, -ascentM) / 800 * 60;
  return Math.round(flat + up + down);
}
