// patch grafica 2: scheda spot essenziale + Dettagli, lista spot più corta, Analisi senza superfluo
const fs = require('fs');
process.chdir(__dirname + '/..');
const P = 'js/app.js';
let s = fs.readFileSync(P, 'utf8');
const rep = (a, b) => { if (!s.includes(a)) throw new Error(a.slice(0, 80)); s = s.replace(a, b); };
const cut = (startMark, endMark, repl) => {
  const i = s.indexOf(startMark); const j = s.indexOf(endMark, i);
  if (i < 0 || j < 0) throw new Error('cut ' + startMark.slice(0, 40));
  s = s.slice(0, i) + repl + s.slice(j);
};

// ---- scheda spot
cut('function spotPopup(s) {', '\nfunction drawAnalysis(', `function spotPopup(s) {
  const prot = s.protected
    ? \`<div class="alert \${s.protected.strict ? 'bad' : 'warn'}" style="margin:8px 0 0">\${s.protected.strict ? 'Riserva integrale: raccolta quasi certamente vietata' : 'Area protetta: verifica il regolamento'} · <b>\${esc(s.protected.name)}</b></div>\` : '';
  const kill = s.killers.length ? \`<div class="alert warn" style="margin:8px 0 0">Timer fermato da: \${s.killers.join(', ')}</div>\` : '';
  const z = s.zone ? (state.analysis?.zones || []).find((x) => x.id === s.zone) : null;
  const stale = s.lastRainDays != null && s.lastRainDays > (s.staleDays || 20);
  const rain = s.lastRainDays != null
    ? \`<span\${stale ? ' style="color:var(--danger)"' : ''}>Pioggia \${itDate(s.lastRainDate)}\${stale ? ' (vecchia)' : ''}</span> · \${s.rainTotal} mm in 20 gg\`
    : \`<span style="color:var(--danger)">Nessuna pioggia utile</span> · \${s.rainTotal} mm in 20 gg\`;
  const road = s.access ? \` · strada a \${s.access.distM < 1000 ? s.access.distM + ' m' : fmt1(s.access.distM / 1000) + ' km'} (\${s.access.walkMin} min)\` : '';
  const pinBg = s.fungaia ? 'var(--charcoal)' : scoreColor(s.score), pinFg = s.fungaia ? 'var(--gold)' : scoreFg(s.score);
  // dettagli: tutto ciò che spiega il voto, a richiesta
  const details = [
    \`\${esc(s.forest)}\${s.edge ? ' · margine o radura' : ''}\`,
    s.fungaia ? \`\${s.nPos} ritrovament\${s.nPos === 1 ? 'o' : 'i'} · \${s.total} esemplari\${s.lastVisit ? \` · ultimo \${new Date(s.lastVisit).toLocaleDateString('it-IT')}\` : ''}\` : '',
    s.micro ? \`<span style="color:var(--ok)">\${microText(s.micro)}</span>\` : '',
    s.nearEmpty ? \`<span style="color:var(--warn)">Uscita a vuoto a \${s.nearEmpty.m} m il \${itDate(s.nearEmpty.date)}: voto ridotto</span>\` : '',
    s.wind ? windText(s.wind) : '',
    z ? \`Giro zona \${z.id}: \${z.spots.join(' → ')} → \${z.spots[0]} (~\${fmt1(z.tourKm)} km)\` : '',
  ].filter(Boolean).map((x) => \`<div>\${x}</div>\`).join('');
  return \`<div class="pop-head">
      <div class="pop-score" style="background:\${pinBg};color:\${pinFg}">\${s.score}</div>
      <div class="grow"><div class="pop-id">\${s.fungaia ? 'La tua fungaia' : \`Spot \${s.id}\`}\${z ? \` <span class="pill zone">Zona \${z.id}</span>\` : ''}</div>
        <div class="pop-sub">\${s.elevation} m · \${s.aspectLabel} · \${s.slope}°</div></div>
    </div>
    <div class="pop-line">\${rain}\${road}</div>
    \${prot}\${kill}
    \${z ? \`<a class="btn small block" style="margin-top:8px" target="_blank" rel="noopener" href="\${zoneTourUrl(z, state.analysis)}">\${icon('nav')} Giro della zona su Mapy</a>\` : ''}
    \${navButtons(s.lat, s.lon, { small: true })}
    <details class="pop-more"><summary>Dettagli</summary>\${details}\${scoreBreakdown(s)}</details>
    \${s.fungaia ? \`<button class="btn small block" style="margin-top:6px" data-open-place="\${s.placeId}">Apri la scheda della fungaia</button>\` : ''}\`;
}
`);
// nomi corti nei pulsanti piccoli
rep(`  links.push(['Google Maps', \`https://www.google.com/maps/dir/?api=1&destination=\${lat},\${lon}&travelmode=\${walk ? 'walking' : 'driving'}\`]);
  links.push(['Mapy.com',`, `  links.push([small ? 'Maps' : 'Google Maps', \`https://www.google.com/maps/dir/?api=1&destination=\${lat},\${lon}&travelmode=\${walk ? 'walking' : 'driving'}\`]);
  links.push([small ? 'Mapy' : 'Mapy.com',`);

// ---- lista spot: due righe
rep(`        <div class="m">\${esc(s.forest)}\${s.edge ? ' · margine' : ''} · pendenza \${s.slope}° · \${distKm(a.center, s).toFixed(1)} km</div>
        <div class="m">T suolo \${fmt1(s.tLocal)} °C · luogo \${s.place} · tempismo \${s.timing}\${s.daysSince != null ? \` · \${s.daysSince} gg da pioggia\` : ''}</div>
        \${s.access ? \`<div class="m">\${accessText(s.access)}</div>\` : ''}
        \${s.regime ? \`<div class="m">\${REGIMES[s.regime].label} · pioggia 20 gg \${s.rainTotal} mm\${s.soil ? \` · \${esc(s.soil.label.toLowerCase())} (\${s.soil.theta}%)\` : ''}</div>\` : ''}`,
`        <div class="m">\${esc(s.forest)} · \${s.slope}° · \${distKm(a.center, s).toFixed(1)} km\${s.access ? \` · strada \${s.access.walkMin} min\` : ''}</div>`);
rep(`        <div class="t">\${s.id} · \${s.elevation} m · \${s.aspectLabel} \${s.zone ? \`<span class="pill zone">Zona \${s.zone}</span> \` : ''}\${s.fungaia ? \`<span class="pill ok">la tua fungaia · \${s.nPos}×</span>\` : s.nearFind ? '<span class="pill ok">vicino a una tua fungaia</span>' : ''}</div>`,
`        <div class="t">\${s.id} · \${s.elevation} m · \${s.aspectLabel} \${s.zone ? \`<span class="pill zone">Zona \${s.zone}</span> \` : ''}\${s.fungaia ? \`<span class="pill ok">tua fungaia</span>\` : ''}</div>`);

// ---- Analisi: via il superfluo
rep(`      <div class="small">Target \${g.band.tMin}–\${g.band.tMax} °C al suolo · \${esc(names)}<br><span class="muted">Bosco tipico: \${FORESTS[G.forest].label} (\${FORESTS[G.forest].altMin}–\${FORESTS[G.forest].altMax} m)</span></div>`,
`      <div class="small">\${esc(names)} · \${g.band.tMin}–\${g.band.tMax} °C al suolo</div>`);
rep(`    return \`<div style="margin-bottom:6px"><b>\${FORESTS[fk].label}</b> · \${status}<br>Migliore: <b>\${itDate(t.from)} → \${itDate(t.to)}</b> <span class="muted">(primi funghi dal \${itDate(t.firstPossible)}\${t.where ? \`, pioggia caduta nella zona di \${t.where}\` : ', pioggia in valle'})</span></div>\`;`,
`    return \`<div style="margin-bottom:6px"><b>\${FORESTS[fk].label}</b> · \${status}<br>Migliore <b>\${itDate(t.from)} → \${itDate(t.to)}</b> <span class="muted">· primi funghi dal \${itDate(t.firstPossible)}</span></div>\`;`);
rep(`<div class="muted">Il timer parte dalla pioggia più vecchia degli ultimi 20 giorni che arriva a 15 mm (sommando i giorni di pioggia consecutivi) e non riparte con le piogge successive. Tra \${state.settings.rainEventMm} e 15 mm il timer parte comunque, con voto −20%. Ogni spot usa la pioggia caduta nella sua zona.</div>`, ``);
rep(`    alerts.push(\`<div class="alert ok">Le tue fungaie nel raggio: <b>\${a.fungaie.length}</b>, valutate nel punto esatto (segnaposto con bordo marrone). La migliore oggi: <b>\${top.id} · \${top.score}/100</b> a \${top.elevation} m. Le trovi in cima alla scheda Spot.</div>\`);`,
`    alerts.push(\`<div class="alert ok">Tue fungaie nel raggio: <b>\${a.fungaie.length}</b> · la migliore oggi <b>\${top.id} · \${top.score}</b></div>\`);`);
rep(`alerts.push(\`<div class="alert ok">Esclusi`, `alerts.push(\`<div class="alert ok small">Esclusi`);
rep(`      <div class="muted">Quota di partenza: \${a.valleyElev} m · gradiente \${a.settings.gradient.toFixed(2).replace('.', ',')} °C/100 m</div>\n`, ``);
rep(`    <div class="legend"><span><i style="background:#16a34a"></i>idoneo autunnale</span><span><i style="background:#ea580c"></i>idoneo estivo</span><span><i style="background:#facc15"></i>marginale</span><span><i style="border:2px solid #dc2626"></i>area protetta</span></div>\n`, ``);
rep(`    <p class="small muted">Riscontri di altri cercatori: <a href="https://funghimagazine.it/" target="_blank" rel="noopener">aggiornamenti nascite su Funghimagazine</a>.</p>\n`, ``);
// situazione del bosco: solo l'essenziale
cut('function situationCard(a) {', '\n// Umidità del suolo', `function situationCard(a) {
  if (!a.clim) return '';
  const c = a.clim, t = a.tc, s = a.summary;
  const counts = { A: 0, B: 0, C: 0 };
  for (const sp of a.spots) if (sp.regime) counts[sp.regime]++;
  const main = ['A', 'B', 'C'].sort((x, y) => counts[y] - counts[x])[0];
  const tLabel = t.high || t.maxAnom ? '<span class="pill bad">sopra la media</span>' : t.low ? '<span class="pill ok">medio-bassa</span>' : '<span class="pill">nella media</span>';
  return \`<h3>Situazione del bosco</h3>
    <div class="card small">
      <div style="font-size:16px;font-weight:800;margin-bottom:2px">\${REGIMES[main].label}</div>
      <div class="muted">\${REGIMES[main].hint}</div>
      <div style="margin-top:8px">Valle \${fmt1(s.meanT)} °C \${tLabel} <span class="muted">· normale \${fmt1(c.normal)} °C</span></div>
      \${soilLine(a)}
    </div>\`;
}
`);
cut('function soilLine(a) {', '\n// Archivio delle analisi', `function soilLine(a) {
  if (a.summary.soilTheta == null) return '';
  const th = Math.round(a.summary.soilTheta * 100);
  return \`<div style="margin-top:6px">Suolo in valle \${th}% <span class="pill \${th >= 50 ? 'ok' : th >= 30 ? 'warn' : 'bad'}">\${th >= 50 ? 'umido' : th >= 30 ? 'al limite' : 'secco'}</span></div>\`;
}
`);
fs.writeFileSync(P, s);

// ---- CSS della nuova scheda
fs.appendFileSync('css/app.css', `
/* ---------- Scheda spot (popup) ---------- */
.leaflet-popup-content { min-width: 240px; }
.pop-head { display: flex; gap: 12px; align-items: center; margin-bottom: 6px; }
.pop-score { width: 52px; height: 52px; border-radius: 16px; display: grid; place-items: center; font-family: var(--font-display); font-size: 28px; flex: none; }
.pop-id { font-weight: 800; font-size: 15px; }
.pop-sub { color: var(--muted); font-size: 13.5px; }
.pop-line { font-size: 13.5px; margin: 2px 0 4px; }
.pop-more { margin-top: 8px; font-size: 13px; }
.pop-more summary { cursor: pointer; color: var(--primary-text); font-weight: 700; padding: 4px 0; }
.pop-more > div { margin: 3px 0; color: var(--muted); }
.pill.ok { color: var(--ok); }
`);
console.log('ok grafica2');
