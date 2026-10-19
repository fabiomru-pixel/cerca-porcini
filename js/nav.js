// Guida a piedi verso uno spot o lungo il giro di una zona, dentro l'app.
// Percorso sui sentieri da BRouter (profilo escursionismo, dati OpenStreetMap), posizione proiettata sul
// percorso, indicazioni di svolta a voce o solo vibrazione, arrivo sugli spot, ricalcolo se esci dal percorso,
// traccia registrata. Nell'app Android la posizione arriva anche a schermo spento (vedi platform.js).
import { distKm } from './geo.js';
import { speak, vibrate, watchPosition } from './platform.js';

const BROUTER = 'https://brouter.de/brouter';
const ARRIVE_M = 30;        // entro questa distanza lo spot è raggiunto
const OFF_ROUTE_M = 40;     // oltre questa distanza dal percorso sei fuori
const MAX_ACC_M = 60;       // posizioni meno precise di così (rete invece del GPS) vengono scartate
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
    targets, back, k: 0, visited: [], track: [], route: null, routeK: 0, proj: 0, off: 0, lastReroute: 0, lastTry: 0,
    pos: null, lastGood: 0, weak: false, startedAt: new Date().toISOString(), finished: false, voice: !!opts.voice,
    said: new Set(), beeline: false, lastBeeSay: null, coarseWarned: false, t0: Date.now(),
  };
  let stop = null, routing = false;

  const say = (text, vib) => { if (vib) vibrate(vib); if (st.voice) speak(text); };
  const legTargets = () => [...st.targets.slice(st.k), ...(st.back ? [st.back] : [])];
  const currentTarget = () => (st.k < st.targets.length ? st.targets[st.k] : st.back);
  // il percorso viene calcolato una volta per tutte le tappe rimaste: la tappa k è al punto 1 + (k - routeK)
  const legIdx = () => {
    const r = st.route;
    return r ? (r.wpIdx[1 + (st.k - st.routeK)] ?? r.coords.length - 1) : null;
  };

  // percorso sui sentieri (serve la rete). Se non c'è rete resta quello vecchio, o si guida in linea d'aria
  async function reroute(from) {
    if (routing) return false;
    routing = true; st.lastTry = Date.now();
    try {
      const pts = [from, ...legTargets()];
      if (pts.length < 2) return false;
      st.route = await walkRoute(pts);
      st.routeK = st.k; st.beeline = false;
      st.proj = 0; st.said.clear(); st.off = 0; st.lastReroute = Date.now();
      return true;
    } catch { return false; } finally { routing = false; }
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

  // posizione imprecisa (rete cellulare/Wi-Fi invece del GPS): la scarto se ne ho una buona recente.
  // Una posizione da ±2 km aveva spostato il punto in un paese vicino mentre l'utente era nel bosco.
  function acceptFix(p) {
    const acc = p.acc ?? 999;
    if (acc <= MAX_ACC_M) { st.lastGood = Date.now(); st.weak = false; return true; }
    st.weak = true;
    if (acc >= 1000 && !st.coarseWarned) {
      st.coarseWarned = true;
      opts.onError?.('Il telefono dà solo una posizione approssimativa (±' + Math.round(acc) + ' m). Attiva il GPS e la posizione "precisa" per Cerca Porcini nelle impostazioni del telefono.');
    }
    // mai oltre 300 m; fino a 300 m solo dopo 2 minuti senza GPS buono (meglio di niente nel bosco fitto)
    return acc <= 300 && Date.now() - Math.max(st.lastGood, st.t0) > 120000;
  }

  async function onPos(p) {
    if (st.finished) return;
    if (!acceptFix(p)) { opts.onUpdate?.(view()); return; }
    st.pos = p;
    const last = st.track[st.track.length - 1];
    if (!last || m(last, p) >= 8) st.track.push({ lat: p.lat, lon: p.lon, time: p.time });

    // percorso: al primo fix, poi riprovo al massimo ogni minuto finché non c'è rete
    if (!st.route && !routing && Date.now() - st.lastTry > 60000) {
      const ok = await reroute(p);
      say(ok ? startText() : beeText(p, 'Senza rete non posso calcolare il percorso sui sentieri: ti guido in linea d\'aria.'), VIB.start);
    }

    // arrivo sulla tappa corrente (funziona sempre, anche senza rete)
    const tgt = currentTarget();
    if (tgt && m(p, tgt) <= ARRIVE_M && (p.acc ?? 0) <= MAX_ACC_M) {
      if (st.k < st.targets.length) {
        st.visited.push(tgt.id); st.k++; st.beeline = false; st.lastBeeSay = null;
        const next = currentTarget();
        say(next ? `Arrivato a ${tgt.label}. Prossimo: ${next.label}, a ${roundM(m(p, next))} metri.` : `Arrivato a ${tgt.label}.`, VIB.arrive);
        opts.onArrive?.(tgt, view());
        if (!next) { finish('completato'); return; }
        opts.onUpdate?.(view()); return; // il percorso verso la prossima tappa è già calcolato
      }
      say('Sei tornato al punto di partenza. Giro completato.', VIB.arrive);
      finish('completato'); return;
    }

    // senza percorso (niente rete): guida in linea d'aria, con un avviso ogni 100 m di avvicinamento
    if (!st.route) { beeline(p, tgt); opts.onUpdate?.(view()); return; }

    // fuori percorso: dopo 3 posizioni di fila avviso e provo a ricalcolare (senza rete tengo il percorso vecchio)
    const d = project(p);
    if (d > OFF_ROUTE_M && (p.acc ?? 0) < 35 && !st.beeline) {
      st.off++;
      if (st.off === 3) say('Sei fuori percorso.', VIB.off);
      if (st.off >= 3 && Date.now() - st.lastReroute > 45000) { st.lastReroute = Date.now(); await reroute(p); }
    } else st.off = 0;

    // ultimo tratto: lo spot sta spesso fuori dal sentiero. Finito il percorso, guida in linea d'aria
    const wi = legIdx();
    const left = st.route.cum[wi] - st.route.cum[st.proj];
    if (tgt && !routing && left < 20 && m(p, tgt) > ARRIVE_M) {
      const key = 'bee' + st.k;
      if (!st.said.has(key)) { st.said.add(key); say(`Lascia il sentiero: ${tgt.label} è a ${roundM(m(p, tgt))} metri verso ${dirName(bearing(p, tgt))}.`, VIB.start); }
      st.beeline = true; st.off = 0;
      opts.onUpdate?.(view()); return;
    }
    st.beeline = false;

    // indicazioni di svolta (solo nel tratto verso la tappa corrente): preavviso a 60 m, poi alla svolta
    const h = st.route.hints.find((x) => x.i > st.proj && x.i <= wi);
    if (h) {
      const dh = st.route.cum[h.i] - st.route.cum[st.proj];
      const key = `${h.i}`;
      if (dh <= 60 && dh > 25 && !st.said.has(key + 'pre')) { st.said.add(key + 'pre'); say(`Tra ${Math.round(dh / 10) * 10} metri, ${TURN[h.cmd]}.`, null); }
      if (dh <= 18 && !st.said.has(key + 'now')) { st.said.add(key + 'now'); say(TURN[h.cmd][0].toUpperCase() + TURN[h.cmd].slice(1) + '.', VIB[side(h.cmd)] || VIB.start); }
    }
    opts.onUpdate?.(view());
  }

  const roundM = (x) => (x >= 1000 ? Math.round(x / 100) * 100 : Math.round(x / 10) * 10);
  function beeText(p, pre) {
    const tgt = currentTarget();
    return tgt ? `${pre} ${tgt.label} a ${roundM(m(p, tgt))} metri verso ${dirName(bearing(p, tgt))}.` : pre;
  }
  function beeline(p, tgt) {
    if (!tgt) return;
    const dist = m(p, tgt), step = dist > 1000 ? 250 : 100;
    const bucket = Math.ceil(dist / step);
    if (st.lastBeeSay == null) st.lastBeeSay = bucket;
    if (bucket < st.lastBeeSay) { st.lastBeeSay = bucket; say(`${tgt.label} a ${roundM(dist)} metri verso ${dirName(bearing(p, tgt))}.`, VIB.start); }
  }

  function startText() {
    const v = view();
    return v.target ? `Partiamo. ${v.target.label} a ${roundM(v.distM)} metri, circa ${v.etaMin} minuti.` : 'Partiamo.';
  }

  function view() {
    const tgt = currentTarget();
    const r = st.route;
    let distM = tgt && st.pos ? m(st.pos, tgt) : null, climb = 0, next = null;
    if (r && tgt && st.pos) {
      const wi = legIdx();
      distM = Math.max(0, r.cum[wi] - r.cum[st.proj]) + (st.beeline ? m(st.pos, tgt) : 0);
      for (let i = st.proj + 1; i <= wi; i++) climb += Math.max(0, (r.coords[i].ele ?? 0) - (r.coords[i - 1].ele ?? 0));
      const h = r.hints.find((x) => x.i > st.proj && x.i <= wi);
      if (h) next = { text: TURN[h.cmd], distM: Math.round(r.cum[h.i] - r.cum[st.proj]), side: side(h.cmd) };
    }
    const bee = tgt && st.pos && (st.beeline || !r);
    return {
      target: tgt, returning: st.k >= st.targets.length, k: st.k, n: st.targets.length,
      distM: distM == null ? null : Math.round(distM), etaMin: distM == null ? null : walkMin(distM, climb),
      next: bee ? { text: `${r ? 'lascia il sentiero, ' : ''}verso ${dirName(bearing(st.pos, tgt))}`, distM: Math.round(m(st.pos, tgt)), side: null, beeline: true } : next,
      off: st.off >= 3, offline: !r, weak: st.weak, pos: st.pos, route: r, visited: st.visited, track: st.track, voice: st.voice,
    };
  }

  return {
    async start() {
      stop = await watchPosition((p) => onPos(p).catch((e) => opts.onError?.(e.message)), (msg) => opts.onError?.(msg));
    },
    setVoice(v) { st.voice = v; },
    skip() { // salta la tappa corrente
      if (st.finished) return;
      if (st.k < st.targets.length) { st.k++; st.beeline = false; st.lastBeeSay = null; if (!currentTarget()) { finish('completato'); return; } opts.onUpdate?.(view()); }
    },
    stop() { finish('interrotto'); },
    view,
  };
}
