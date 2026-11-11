// patch: stato senza rete / GPS debole nella barra della guida, posizione più affidabile, bussola auto
const fs = require('fs');
process.chdir(__dirname + '/..');
const f = 'js/app.js';
let s = fs.readFileSync(f, 'utf8');
const rep = (a, b) => { if (!s.includes(a)) throw new Error(a.slice(0, 80)); s = s.replace(a, () => b); };

// 1. barra della guida
rep("  const instr = v.off ? 'Fuori percorso: ricalcolo' : !r ? 'Calcolo il percorso…' : v.next && v.next.distM < 250 ? `${navDist(v.next.distM)} · ${v.next.text}` : 'Prosegui sul sentiero';",
  "  const instr = !v.pos ? 'Cerco il segnale GPS…' : v.off ? 'Fuori percorso' : v.next?.beeline ? `${navDist(v.next.distM)} · ${v.next.text}` : v.next && v.next.distM < 250 ? `${navDist(v.next.distM)} · ${v.next.text}` : 'Prosegui sul sentiero';\n  const flags = [v.offline && v.pos ? 'senza rete: guida in linea d\\'aria' : '', v.weak ? 'GPS debole' : ''].filter(Boolean).join(' · ');");
rep("      <div class=\"nav-sub\">${tgt} · <b>${navDist(v.distM)}</b>${v.etaMin != null ? ` · ~${navDur(v.etaMin)}` : ''}${v.n > 1 ? ` · tappa ${Math.min(v.k + 1, v.n)}/${v.n}` : ''}</div></div></div>${navButtonsHtml()}`;",
  "      <div class=\"nav-sub\">${tgt} · <b>${navDist(v.distM)}</b>${v.etaMin != null ? ` · ~${navDur(v.etaMin)}` : ''}${v.n > 1 ? ` · tappa ${Math.min(v.k + 1, v.n)}/${v.n}` : ''}</div>${flags ? `<div class=\"nav-sub\" style=\"color:var(--warn)\">${flags}</div>` : ''}</div></div>${navButtonsHtml()}`;");

// 2. "La mia posizione": ascolto il GPS fino a 15 s e tengo la posizione più precisa, non la prima che arriva
// (la prima spesso viene dalla rete cellulare: anche 2 km di errore)
const i = s.indexOf('function locate({ silent = false, center = false } = {}) {');
const j = s.indexOf('function renderStart() {');
if (i < 0 || j < 0) throw new Error('locate');
s = s.slice(0, i) + `function locate({ silent = false, center = false } = {}) {
  if (!navigator.geolocation) { if (!silent) toast('GPS non disponibile'); return; }
  let best = null, done = false, wid = null, timer = null;
  const apply = (fx, final) => {
    state.gps = fx;
    if (final) kv.set('lastGps', fx);
    if (!state.start || !state.start.manual) state.start = { lat: fx.lat, lon: fx.lon, manual: false };
    renderStart(); drawMe();
    if (center && final) map.setView([fx.lat, fx.lon], Math.max(map.getZoom(), fx.acc > 300 ? 13 : 15));
  };
  const finish = () => {
    if (done) return;
    done = true; clearTimeout(timer); if (wid != null) navigator.geolocation.clearWatch(wid);
    if (!best) { if (!silent) toast('Posizione non disponibile: attiva il GPS'); renderStart(); return; }
    apply(best, true);
    if (!silent && best.acc > 100) {
      toast(best.acc >= 1000
        ? \`Posizione molto approssimativa (±\${(best.acc / 1000).toFixed(1)} km): attiva il GPS e la posizione "precisa" per l'app nelle impostazioni del telefono\`
        : \`Posizione approssimativa (±\${Math.round(best.acc)} m): il GPS non ha ancora un buon segnale, riprova all'aperto\`, 8000);
    }
  };
  wid = navigator.geolocation.watchPosition((p) => {
    const fx = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, alt: p.coords.altitude };
    if (!best || fx.acc < best.acc) { best = fx; if (!silent) apply(best, false); }
    if (best.acc <= 25) finish(); // abbastanza preciso: mi fermo
  }, (e) => {
    if (best) { finish(); return; }
    done = true; clearTimeout(timer); if (wid != null) navigator.geolocation.clearWatch(wid);
    if (!silent) toast(e.code === 1 ? 'Permesso di posizione negato' : 'Posizione non disponibile');
    renderStart();
  }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  timer = setTimeout(finish, 15000);
}

` + s.slice(j);

// 3. bussola "torna all'auto": scarto le posizioni imprecise se ne ho una buona recente
rep(`    carWatch = navigator.geolocation.watchPosition((p) => {
      carHere = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };`, `    let carGood = 0;
    carWatch = navigator.geolocation.watchPosition((p) => {
      // posizione dalla rete (imprecisa): la ignoro se negli ultimi 2 minuti ne ho avuta una buona dal GPS
      if (p.coords.accuracy > 60 && Date.now() - carGood < 120000) return;
      if (p.coords.accuracy <= 60) carGood = Date.now();
      carHere = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };`);
rep(`      navigator.geolocation.getCurrentPosition((p) => setCar({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }),`,
  `      navigator.geolocation.getCurrentPosition((p) => { setCar({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }); if (p.coords.accuracy > 60) toast(\`Attenzione: posizione dell'auto approssimativa (±\${Math.round(p.coords.accuracy)} m). Riprova tra poco o usa "Centro mappa".\`, 7000); },`);
fs.writeFileSync(f, s);
console.log('ok');
