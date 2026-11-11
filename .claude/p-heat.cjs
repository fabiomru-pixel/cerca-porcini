// patch (anteprima): attorno a ogni spot l'area colorata in base a quanto è promettente ogni punto vicino
const fs = require('fs');
process.chdir(__dirname + '/..');
const rep = (f, a, b) => { let s = fs.readFileSync(f, 'utf8'); if (!s.includes(a)) throw new Error(f + ': ' + a.slice(0, 80)); fs.writeFileSync(f, s.replace(a, () => b)); };
const A = 'js/analysis.js';
rep(A, `      if (out.every((o) => distKm(o, x) >= 0.4)) out.push(x);
    }
    return out.length ? out : [c];`, `      if (out.every((o) => distKm(o, x) >= 0.4)) out.push(x);
    }
    // area dello spot: i punti entro 500 m con almeno il 40% del suo valore (per la colorazione sulla mappa)
    for (const o of out) {
      o.heat = cells
        .filter((x) => x.fin >= 0.4 * o.fin && distKm(o, x) <= 0.5)
        .slice(0, 700)
        .map((x) => [Math.round(x.lat * 1e5) / 1e5, Math.round(x.lon * 1e5) / 1e5, Math.round(Math.min(1, x.fin / o.fin) * 100)]);
      o.heatCell = Math.round(st * mppF); // passo della griglia in metri
    }
    return out.length ? out : [c];`);
rep(A, `        forestType: c.patch ? \`\${c.patch.type}, copertura \${Math.round(c.patch.frac * 100)}%\` : null,`, `        forestType: c.patch ? \`\${c.patch.type}, copertura \${Math.round(c.patch.frac * 100)}%\` : null,
        heat: c.heat || null, heatCell: c.heatCell || 30,`);

const P = 'js/app.js';
rep(P, `  for (const s of a.spots) {`, `  // area probabile attorno a ogni spot: più è intenso il colore, più il punto è promettente
  layers.heat.clearLayers();
  const heatR = L.canvas({ padding: 0.3 });
  const heatColor = (v) => { // da verde salice (meno probabile) a oro e arancio (più probabile)
    const stops = [[0.4, [138, 203, 136]], [0.75, [255, 191, 70]], [1, [232, 89, 12]]];
    const t = Math.max(0.4, Math.min(1, v));
    for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) {
      const [a0, c0] = stops[i - 1], [a1, c1] = stops[i], k = (t - a0) / (a1 - a0);
      return \`rgb(\${c0.map((x, j) => Math.round(x + (c1[j] - x) * k)).join(',')})\`;
    }
    return 'rgb(232,89,12)';
  };
  for (const s of a.spots) {
    if (!s.heat) continue;
    const r = Math.max(15, (s.heatCell || 30) * 0.75);
    for (const [la, lo, p] of s.heat) {
      const v = p / 100;
      L.circle([la, lo], { renderer: heatR, radius: r, stroke: false, fillColor: heatColor(v), fillOpacity: 0.06 + 0.5 * Math.pow((v - 0.4) / 0.6, 1.6), interactive: false }).addTo(layers.heat);
    }
  }
  for (const s of a.spots) {`);
rep(P, `  layers.suit = L.layerGroup().addTo(map);`, `  layers.suit = L.layerGroup().addTo(map);
  layers.heat = L.layerGroup().addTo(map);`);
rep(P, `    'Idoneità (calore)': layers.suit,`, `    'Idoneità (calore)': layers.suit,
    'Area probabile degli spot': layers.heat,`);
rep(P, `  layers.suit.clearLayers(); layers.contours.clearLayers();`, `  layers.suit.clearLayers(); layers.heat?.clearLayers(); layers.contours.clearLayers();`);
console.log('ok');
