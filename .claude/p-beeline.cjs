const fs = require('fs');
process.chdir(__dirname + '/..');
const f = 'js/nav.js';
let s = fs.readFileSync(f, 'utf8');
const rep = (a, b) => { if (!s.includes(a)) throw new Error(a.slice(0, 60)); s = s.replace(a, b); };
rep(`const m = (a, b) => distKm(a, b) * 1000;`, `const m = (a, b) => distKm(a, b) * 1000;
// direzione in parole (per l'ultimo tratto fuori sentiero)
const DIRS = ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ovest', 'ovest', 'nord-ovest'];
function bearing(a, b) {
  const y = Math.sin(((b.lon - a.lon) * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180);
  const x = Math.cos((a.lat * Math.PI) / 180) * Math.sin((b.lat * Math.PI) / 180) - Math.sin((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.cos(((b.lon - a.lon) * Math.PI) / 180);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
const dirName = (deg) => DIRS[Math.round(deg / 45) % 8];`);
// fuori sentiero: quando il percorso verso la tappa è finito ma lo spot è ancora lontano
rep(`    // indicazioni di svolta: preavviso a 60 m, poi alla svolta`, `    // ultimo tratto: lo spot sta spesso fuori dal sentiero. Finito il percorso, guida in linea d'aria
    const wi = st.route.wpIdx[1] ?? st.route.coords.length - 1;
    const left = st.route.cum[wi] - st.route.cum[st.proj];
    if (tgt && left < 20 && m(p, tgt) > ARRIVE_M) {
      const key = 'bee' + st.k;
      if (!st.said.has(key)) { st.said.add(key); say(\`Lascia il sentiero: \${tgt.label} è a \${Math.round(m(p, tgt) / 10) * 10} metri verso \${dirName(bearing(p, tgt))}.\`, VIB.start); }
      st.beeline = true; st.off = 0;
      opts.onUpdate?.(view()); return;
    }
    st.beeline = false;

    // indicazioni di svolta: preavviso a 60 m, poi alla svolta`);
// nel fuori sentiero non segnalare "fuori percorso"
rep(`    const d = project(p);
    if (d > OFF_ROUTE_M && (p.acc ?? 0) < 35) {`, `    const d = project(p);
    if (d > OFF_ROUTE_M && (p.acc ?? 0) < 35 && !st.beeline) {`);
// vista: distanza in linea d'aria e direzione nel fuori sentiero
rep(`      next, off: st.off >= 3, pos: st.pos,`, `      next: st.beeline && tgt && st.pos ? { text: \`lascia il sentiero, verso \${dirName(bearing(st.pos, tgt))}\`, distM: Math.round(m(st.pos, tgt)), side: null, beeline: true } : next,
      off: st.off >= 3, pos: st.pos,`);
rep(`      distM = Math.max(0, r.cum[wi] - r.cum[st.proj]);`, `      distM = Math.max(0, r.cum[wi] - r.cum[st.proj]) + (st.beeline ? m(st.pos, tgt) : 0);`);
// l'ultimo tratto va spostato prima dei controlli di fuori percorso: il codice è già nell'ordine giusto?
fs.writeFileSync(f, s);
console.log('ok');
