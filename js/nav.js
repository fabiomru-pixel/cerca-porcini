// Guida a piedi verso uno spot o lungo il giro di una zona, dentro l'app.
// Percorso sui sentieri da BRouter (profilo escursionismo, dati OpenStreetMap), posizione proiettata sul
// percorso, indicazioni di svolta a voce o solo vibrazione, arrivo sugli spot, ricalcolo se esci dal percorso,
// traccia registrata. Nell'app Android la posizione arriva anche a schermo spento (vedi platform.js).
import { distKm } from './geo.js';
import { speak, vibrate, watchPosition } from './platform.js';

const BROUTER = 'https://brouter.de/brouter';
const ARRIVE_M = 30;        // entro questa distanza lo spot è raggiunto
const OFF_ROUTE_M = 40;     // oltre questa distanza dal percorso sei fuori
const WALK_KMH = 3.5;       // passo nel bosco, senza dislivello
const CLIMB_M_PER_H = 400;  // salita: +1 ora ogni 400 m

// comandi di svolta di BRouter -> parole
const TURN = {
  2: 'gira a sinistra', 3: 'tieni leggermente a sinistra', 4: 'gira decisamente a sinistra',
  5: 'gira a destra', 6: 'tieni leggermente a destra', 7: 'gira decisamente a destra',
  8: 'tieni la sinistra', 9: 'tieni la destra', 10: 'torna indietro', 11: 'torna indietro', 12: 'torna indietro',
};
// vibrazioni: svolta a sinistra 2 brevi, a destra 3 brevi, arrivo lunga-lunga, fuori percorso lunghissima
const VIB = { left: [150, 120, 150], right: [150, 120, 150, 120, 150], arrive: [500, 200, 500], off: [900], start: [200] };
const side = (cmd) => ([2, 3, 4, 8].includes(cmd) ? 'left' : [5, 6, 7, 9].includes(cmd) ? 'right' : null);

const m = (a, b) => distKm(a, b) * 1000;
// direzione in parole (per l'ultimo tratto fuori sentiero)
const DIRS = ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ovest', 'ovest', 'nord-ovest'];
function bearing(a, b) {
  const y = Math.sin(((b.lon - a.lon) * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180);
  const x = Math.cos((a.lat * Math.PI) / 180) * Math.sin((b.lat * Math.PI) / 180) - Math.sin((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.cos(((b.lon - a.lon) * Math.PI) / 180);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
const dirName = (deg) => DIRS[Math.round(deg / 45) % 8];

export async function walkRoute(points) {
  const lonlats = points.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join('|');
  const r = await fetch(`${BROUTER}?lonlats=${lonlats}&profile=hiking-mountain&alternativeidx=0&format=geojson&timode=3`, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`Percorso a piedi non disponibile (${r.status})`);
  const f = (await r.json()).features[0];
  const coords = f.geometry.coordinates.map(([lon, lat, ele]) => ({ lat, lon, ele }));
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + m(coords[i - 1], coords[i]));
  // indice del percorso più vicino a ogni tappa (in ordine)
  const wpIdx = [];
  let from = 0;
  for (const p of points) {
    let best = from, bd = Infinity;
    for (let i = from; i < coords.length; i++) { const d = m(p, coords[i]); if (d < bd) { bd = d; best = i; } }
    wpIdx.push(best); from = best;
  }
  return {
    coords, cum, wpIdx,
    length: Number(f.properties['track-length']) || cum[cum.length - 1],
    ascent: Number(f.properties['filtered ascend']) || 0,
    hints: (f.properties.voicehints || []).map(([i, cmd]) => ({ i, cmd })).filter((h) => TURN[h.cmd]),
  };
}

// minuti di cammino per una distanza (m) e una salita (m)
export const walkMin = (distM, climbM = 0) => Math.round((distM / 1000 / WALK_KMH) * 60 + (Math.max(0, climbM) / CLIMB_M_PER_H) * 60);

// Sessione di guida. targets: [{ id, label, lat, lon }] in ordine; back: punto di ritorno (o null)
// opts: { voice, onUpdate(state), onArrive(target, state), onFinish(summary), onError(msg) }
export function createNav(targets, back, opts) {
  const st = {
    targets, back, k: 0, visited: [], track: [], route: null, proj: 0, off: 0, lastReroute: 0,
    pos: null, startedAt: new Date().toISOString(), finished: false, voice: !!opts.voice, said: new Set(),
  };
  let stop = null, routing = false;

  const say = (text, vib) => { if (vib) vibrate(vib); if (st.voice) speak(text); };
  const legTargets = () => [...st.targets.slice(st.k), ...(st.back ? [st.back] : [])];
  const currentTarget = () => (st.k < st.targets.length ? st.targets[st.k] : st.back);

  async function reroute(from) {
    if (routing) return;
    routing = true;
    try {
      const pts = [from, ...legTargets()];
      if (pts.length < 2) return;
      st.route = await walkRoute(pts);
      st.routeK = st.k; // il percorso porta a questa tappa
      st.beeline = false;
      st.proj = 0; st.said.clear(); st.off = 0; st.lastReroute = Date.now();
    } catch (e) { opts.onError?.(e.message); } finally { routing = false; }
  }

  // proiezione sul percorso: cerco vicino all'ultimo punto, poi su tutto se serve
  function project(p) {
    const c = st.route.coords;
    let best = st.proj, bd = Infinity;
    const lo = Math.max(0, st.proj - 20), hi = Math.min(c.length - 1, st.proj + 80);
    for (let i = lo; i <= hi; i++) { const d = m(p, c[i]); if (d < bd) { bd = d; best = i; } }
    if (bd > OFF_ROUTE_M) for (let i = 0; i < c.length; i++) { const d = m(p, c[i]); if (d < bd) { bd = d; best = i; } }
    st.proj = best;
    return bd;
  }

  function finish(reason) {
    if (st.finished) return;
    st.finished = true;
    stop?.();
    const walked = st.track.reduce((a, p, i) => (i ? a + m(st.track[i - 1], p) : 0), 0);
    opts.onFinish?.({
      startedAt: st.startedAt, endedAt: new Date().toISOString(), reason,
      targets: st.targets.map(({ id, label, lat, lon }) => ({ id, label, lat, lon })),
      visited: [...st.visited], distanceM: Math.round(walked),
      track: st.track.map((p) => [Math.round(p.lat * 1e6) / 1e6, Math.round(p.lon * 1e6) / 1e6, p.time]),
    });
  }

  async function onPos(p) {
    if (st.finished) return;
    st.pos = p;
    const last = st.track[st.track.length - 1];
    if (!last || m(last, p) >= 8) st.track.push({ lat: p.lat, lon: p.lon, time: p.time });
    if (!st.route) { await reroute(p); if (st.route) say(startText(), VIB.start); }
    if (!st.route) { opts.onUpdate?.(view()); return; }

    // arrivo sulla tappa corrente
    const tgt = currentTarget();
    if (tgt && m(p, tgt) <= ARRIVE_M) {
      if (st.k < st.targets.length) {
        st.visited.push(tgt.id); st.k++; st.beeline = false;
        const next = currentTarget();
        say(next ? `Arrivato a ${tgt.label}. Prossimo: ${next.label}.` : `Arrivato a ${tgt.label}.`, VIB.arrive);
        opts.onArrive?.(tgt, view());
        if (!next) { finish('completato'); return; }
        await reroute(p); opts.onUpdate?.(view()); return;
      }
      say('Sei tornato al punto di partenza. Giro completato.', VIB.arrive);
      finish('completato'); return;
    }

    // fuori percorso: dopo 3 posizioni di fila, avviso e ricalcolo (al massimo ogni 45 secondi)
    const d = project(p);
    if (d > OFF_ROUTE_M && (p.acc ?? 0) < 35 && !st.beeline) {
      st.off++;
      if (st.off === 3) say('Sei fuori percorso. Ricalcolo.', VIB.off);
      if (st.off >= 3 && Date.now() - st.lastReroute > 45000) await reroute(p);
    } else st.off = 0;

    // ultimo tratto: lo spot sta spesso fuori dal sentiero. Finito il percorso, guida in linea d'aria
    const wi = st.route.wpIdx[1] ?? st.route.coords.length - 1;
    const left = st.route.cum[wi] - st.route.cum[st.proj];
    if (tgt && !routing && st.routeK === st.k && left < 20 && m(p, tgt) > ARRIVE_M) {
      const key = 'bee' + st.k;
      if (!st.said.has(key)) { st.said.add(key); say(`Lascia il sentiero: ${tgt.label} è a ${Math.round(m(p, tgt) / 10) * 10} metri verso ${dirName(bearing(p, tgt))}.`, VIB.start); }
      st.beeline = true; st.off = 0;
      opts.onUpdate?.(view()); return;
    }
    st.beeline = false;

    // indicazioni di svolta: preavviso a 60 m, poi alla svolta
    const h = st.route.hints.find((x) => x.i > st.proj);
    if (h) {
      const dh = st.route.cum[h.i] - st.route.cum[st.proj];
      const key = `${h.i}`;
      if (dh <= 60 && dh > 25 && !st.said.has(key + 'pre')) { st.said.add(key + 'pre'); say(`Tra ${Math.round(dh / 10) * 10} metri, ${TURN[h.cmd]}.`, null); }
      if (dh <= 18 && !st.said.has(key + 'now')) { st.said.add(key + 'now'); say(TURN[h.cmd][0].toUpperCase() + TURN[h.cmd].slice(1) + '.', VIB[side(h.cmd)] || VIB.start); }
    }
    opts.onUpdate?.(view());
  }

  function startText() {
    const v = view();
    return v.target ? `Partiamo. ${v.target.label} a ${Math.round(v.distM / 10) * 10} metri, circa ${v.etaMin} minuti.` : 'Partiamo.';
  }

  function view() {
    const tgt = currentTarget();
    const r = st.route;
    let distM = tgt && st.pos ? m(st.pos, tgt) : null, climb = 0, next = null;
    if (r && tgt && st.pos) {
      const wi = r.wpIdx[1] ?? r.coords.length - 1; // il percorso parte dalla posizione: la tappa 1 è il bersaglio
      distM = Math.max(0, r.cum[wi] - r.cum[st.proj]) + (st.beeline ? m(st.pos, tgt) : 0);
      for (let i = st.proj + 1; i <= wi; i++) climb += Math.max(0, (r.coords[i].ele ?? 0) - (r.coords[i - 1].ele ?? 0));
      const h = r.hints.find((x) => x.i > st.proj && x.i <= wi);
      if (h) next = { text: TURN[h.cmd], distM: Math.round(r.cum[h.i] - r.cum[st.proj]), side: side(h.cmd) };
    }
    return {
      target: tgt, returning: st.k >= st.targets.length, k: st.k, n: st.targets.length,
      distM: distM == null ? null : Math.round(distM), etaMin: distM == null ? null : walkMin(distM, climb),
      next: st.beeline && tgt && st.pos ? { text: `lascia il sentiero, verso ${dirName(bearing(st.pos, tgt))}`, distM: Math.round(m(st.pos, tgt)), side: null, beeline: true } : next,
      off: st.off >= 3, pos: st.pos, route: r, visited: st.visited, track: st.track, voice: st.voice,
    };
  }

  return {
    async start() {
      stop = await watchPosition((p) => onPos(p).catch((e) => opts.onError?.(e.message)), (msg) => opts.onError?.(msg));
    },
    setVoice(v) { st.voice = v; },
    skip() { // salta la tappa corrente
      if (st.finished) return;
      if (st.k < st.targets.length) { st.k++; if (!currentTarget()) { finish('completato'); return; } if (st.pos) reroute(st.pos).then(() => opts.onUpdate?.(view())); }
    },
    stop() { finish('interrotto'); },
    view,
  };
}
