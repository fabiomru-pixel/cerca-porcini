// patch: guida a piedi nell'app (barra di navigazione, pulsanti, scheda Giri, domanda "giro a vuoto")
const fs = require('fs');
process.chdir(__dirname + '/..');
const rep = (f, a, b) => { let s = fs.readFileSync(f, 'utf8'); if (!s.includes(a)) throw new Error(f + ': ' + a.slice(0, 80)); fs.writeFileSync(f, s.replace(a, b)); };

// ---------- config
rep('js/config.js', `  forestPref: 'auto',     // auto (misto) | quercia | faggio`, `  forestPref: 'auto',     // auto (misto) | quercia | faggio
  navVoice: true,         // guida a piedi: indicazioni a voce (false = solo vibrazione)`);

// ---------- icone
rep('js/icons.js', `  nav: '<path d="M3 11l18-8-8 18-2-8z"/>',`, `  nav: '<path d="M3 11l18-8-8 18-2-8z"/>',
  walk: '<circle cx="13" cy="4" r="2"/><path d="M10 21l2-6 2.5 2.5V21M8 12l2.5-4.5L14 9l2.5 3M10.5 7.5 9 14"/>',
  volume: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/>',
  vibrate: '<rect x="8" y="3" width="8" height="18" rx="2"/><path d="M4 8v8M20 8v8M1.5 10v4M22.5 10v4"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  skip: '<path d="M5 5l9 7-9 7zM17 5v14"/>',
  left: '<path d="M14 19V9a3 3 0 0 0-3-3H5M9 2 5 6l4 4"/>',
  right: '<path d="M10 19V9a3 3 0 0 1 3-3h6M15 2l4 4-4 4"/>',
  up: '<path d="M12 20V4M6 10l6-6 6 6"/>',`);

// ---------- HTML
const H = 'index.html';
rep(H, `      <button class="tab" role="tab" data-tab="fungaie"></button>`, `      <button class="tab" role="tab" data-tab="fungaie"></button>
      <button class="tab" role="tab" data-tab="giri"></button>`);
rep(H, `    <!-- IMPOSTAZIONI -->`, `    <!-- GIRI: riepiloghi delle uscite con la guida a piedi -->
    <section class="tab-body" data-body="giri" hidden>
      <div id="outingList"></div>
    </section>

    <!-- IMPOSTAZIONI -->`);
rep(H, `      <h3>Regole</h3>`, `      <div class="field">
        <span class="label">Guida a piedi</span>
        <div class="seg" id="voiceSeg">
          <button data-v="1">Voce e vibrazione</button><button data-v="0">Solo vibrazione</button>
        </div>
      </div>

      <h3>Regole</h3>`);
rep(H, `  <div id="map"></div>`, `  <div id="map"></div>

  <div class="navbar" id="navBar" hidden></div>
  <dialog id="outDlg"><form method="dialog" id="outForm"></form></dialog>`);

// ---------- CSS
fs.appendFileSync('css/app.css', `
/* ---------- Guida a piedi ---------- */
.navbar { position: fixed; top: calc(var(--appbar-h) + 8px); left: 10px; right: 10px; z-index: 1060; background: var(--surface); color: var(--text);
  border-radius: 18px; box-shadow: var(--shadow); padding: 10px 12px; max-width: 520px; margin: 0 auto; }
@media (min-width: 900px) { .navbar { left: calc(var(--panel-w) + 24px); right: 24px; margin: 0; } }
body.nav-on .search { display: none; }
.nav-main { display: flex; align-items: center; gap: 12px; }
.nav-turn { width: 52px; height: 52px; border-radius: 14px; background: var(--teal); color: #fff; display: grid; place-items: center; flex: none; }
.nav-turn svg.i { width: 32px; height: 32px; stroke-width: 2.4; }
.nav-turn.off { background: var(--danger); }
.nav-instr { font-weight: 800; font-size: 18px; line-height: 1.2; }
.nav-sub { color: var(--muted); font-size: 13.5px; margin-top: 2px; }
.nav-sub b { color: var(--text); font-family: var(--font-display); font-weight: 400; font-size: 17px; }
.nav-btns { display: flex; gap: 6px; margin-top: 8px; }
.nav-btns .btn { flex: 1; padding: 8px 6px; font-size: 13px; }
.nav-btns .btn.stop { color: var(--danger); }
.out-card .t { font-weight: 800; }
.out-card .m { font-size: 13px; color: var(--muted); margin-top: 2px; }
.out-sum { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 8px 0 12px; }
.out-sum div { background: var(--surface-2); border-radius: 12px; padding: 8px; text-align: center; }
.out-sum b { display: block; font-family: var(--font-display); font-weight: 400; font-size: 22px; color: var(--primary-text); }
.out-sum span { font-size: 12px; color: var(--muted); }
#outDlg form { padding: 16px; }
`);

// ---------- JS
const P = 'js/app.js';
rep(P, `import { icon } from './icons.js';`, `import { icon } from './icons.js';
import { NATIVE } from './platform.js';
import { createNav, walkMin } from './nav.js';`);
rep(P, `  const tabs = { analisi: ['target', 'Analisi'], spot: ['list', 'Spot'], fungaie: ['mushroom', 'Fungaie'], impostazioni: ['settings', 'Opzioni'] };`,
  `  const tabs = { analisi: ['target', 'Analisi'], spot: ['list', 'Spot'], fungaie: ['mushroom', 'Fungaie'], giri: ['walk', 'Giri'], impostazioni: ['settings', 'Opzioni'] };`);
// pulsanti nella scheda spot
rep(P, `    \${z ? \`<a class="btn small block" style="margin-top:8px" target="_blank" rel="noopener" href="\${zoneTourUrl(z, state.analysis)}">\${icon('nav')} Giro della zona su Mapy</a>\` : ''}`,
  `    <div class="nav-row" style="margin-top:8px">
      <button class="btn small primary" data-walk-spot="\${s.id}">\${icon('walk')} A piedi qui</button>
      \${z ? \`<button class="btn small primary" data-walk-zone="\${z.id}">\${icon('walk')} Giro zona \${z.id}</button>\` : ''}
    </div>
    \${z ? \`<a class="btn small block" style="margin-top:6px" target="_blank" rel="noopener" href="\${zoneTourUrl(z, state.analysis)}">\${icon('nav')} Giro della zona su Mapy</a>\` : ''}`);
rep(P, `    if (b) b.onclick = () => { map.closePopup(); openView(b.dataset.openPlace); };
  });`, `    if (b) b.onclick = () => { map.closePopup(); openView(b.dataset.openPlace); };
    const ws = e.popup.getElement()?.querySelector('[data-walk-spot]');
    if (ws) ws.onclick = () => { map.closePopup(); walkToSpot(ws.dataset.walkSpot); };
    const wz = e.popup.getElement()?.querySelector('[data-walk-zone]');
    if (wz) wz.onclick = () => { map.closePopup(); walkZone(wz.dataset.walkZone); };
  });`);
// pulsante nella card della zona
rep(P, `      <a class="btn primary block" style="margin-top:8px" target="_blank" rel="noopener" data-stop href="\${zoneTourUrl(z, a)}">\${icon('nav')} Giro a piedi su Mapy</a>`,
  `      <button class="btn primary block" style="margin-top:8px" data-stop data-walk-zone="\${z.id}">\${icon('walk')} Avvia il giro nell'app</button>
      <a class="btn block" style="margin-top:6px" target="_blank" rel="noopener" data-stop href="\${zoneTourUrl(z, a)}">\${icon('nav')} Giro a piedi su Mapy</a>`);
rep(P, `  $$('.zone-card [data-stop]').forEach((x) => x.addEventListener('click', (e) => e.stopPropagation()));`,
  `  $$('.zone-card [data-stop]').forEach((x) => x.addEventListener('click', (e) => e.stopPropagation()));
  $$('.zone-card [data-walk-zone]').forEach((x) => x.addEventListener('click', () => walkZone(x.dataset.walkZone)));`);
// impostazione voce
rep(P, `  $('#forestPref').onchange = (e) => saveSettings({ forestPref: e.target.value });`, `  $('#forestPref').onchange = (e) => saveSettings({ forestPref: e.target.value });
  $$('#voiceSeg button').forEach((b) => b.onclick = () => { saveSettings({ navVoice: b.dataset.v === '1' }); renderVoiceSeg(); nav?.setVoice(state.settings.navVoice); });`);
rep(P, `  $('#forestPref').value = s.forestPref || 'auto';`, `  $('#forestPref').value = s.forestPref || 'auto';
  renderVoiceSeg();`);
// service worker solo nel browser; nell'app non serve
rep(P, `  if ('serviceWorker' in navigator && location.protocol !== 'file:') {`, `  if (!NATIVE && 'serviceWorker' in navigator && location.protocol !== 'file:') {`);
// Drive: nell'app per ora non si può accedere (Google blocca l'accesso dentro le app incorporate)
rep(P, `async function doSync() {
`, `async function doSync() {
  if (NATIVE) { toast('Nell\\'app la sincronizzazione con Drive non è ancora disponibile: usa Esporta/Importa backup in Opzioni', 6000); return; }
`);
rep(P, `  await refreshFinds();
  locate({ silent: true });`, `  await refreshFinds();
  renderOutings();
  locate({ silent: true });`);

// ---- blocco della guida a piedi
rep(P, `// ---------------------------------------------------------------- tab e pannello`, `// ---------------------------------------------------------------- guida a piedi
let nav = null, navMeta = null, navLayers = null, navRouteRef = null, followPausedUntil = 0;
const fmtDist = (mm) => (mm == null ? '–' : mm >= 1000 ? \`\${fmt1(mm / 1000)} km\` : \`\${Math.round(mm / 10) * 10} m\`);
const fmtDur = (min) => (min >= 60 ? \`\${Math.floor(min / 60)} h \${String(min % 60).padStart(2, '0')}'\` : \`\${min}'\`);

function renderVoiceSeg() {
  $$('#voiceSeg button').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.v === '1') === !!state.settings.navVoice)));
}

function walkToSpot(id) {
  const a = state.analysis;
  const s = a?.spots.find((x) => x.id === id) || a?.fungaie?.find((x) => x.id === id);
  if (!s) return;
  startNav([{ id: s.id, label: s.fungaia ? 'la tua fungaia' : \`spot \${s.id}\`, lat: s.lat, lon: s.lon }], null, { mode: 'spot', title: s.fungaia ? \`Fungaia \${s.id}\` : \`Spot \${s.id}\`, score: s.score });
}
function walkZone(zid) {
  const a = state.analysis;
  const z = a?.zones.find((x) => x.id === zid);
  if (!z) return;
  const pts = zonePts(z, a);
  const targets = pts.map((p) => ({ id: p.id, label: p.fungaia ? \`la fungaia \${p.id}\` : \`spot \${p.id}\`, lat: p.lat, lon: p.lon }));
  // ritorno: all'auto se è parcheggiata vicino, altrimenti allo spot vicino alla strada da cui parte il giro
  const back = state.car && distKm(state.car, targets[0]) <= 3 ? { id: 'auto', label: 'l\\'auto', lat: state.car.lat, lon: state.car.lon } : { ...targets[0], id: 'ritorno', label: \`il punto di partenza \${targets[0].id}\` };
  startNav(targets, back, { mode: 'zona', title: \`Giro zona \${z.id}\`, zone: z.id });
}

async function startNav(targets, back, meta) {
  if (nav) { toast('C\\'è già una guida in corso'); return; }
  navMeta = meta;
  if (!navLayers) navLayers = L.layerGroup().addTo(map);
  navLayers.clearLayers(); navRouteRef = null;
  targets.forEach((t, i) => L.circleMarker([t.lat, t.lon], { radius: 9, color: '#FFBF46', weight: 3, fillOpacity: 0.25 }).bindTooltip(\`\${i + 1}. \${t.label}\`).addTo(navLayers));
  document.body.classList.add('nav-on');
  $('#navBar').hidden = false;
  $('#navBar').innerHTML = \`<div class="nav-main"><div class="nav-turn">\${icon('walk')}</div><div><div class="nav-instr">Cerco la posizione…</div><div class="nav-sub">\${esc(meta.title)} · calcolo il percorso sui sentieri</div></div></div>\${navButtonsHtml()}\`;
  bindNavButtons();
  if (innerWidth < 900) setSheet('peek');
  map.on('dragstart', pauseFollow);
  nav = createNav(targets, back, {
    voice: state.settings.navVoice,
    onUpdate: renderNav,
    onArrive: (t) => toast(\`Arrivato a \${t.label}\`),
    onFinish: finishNav,
    onError: (msg) => toast(msg, 5000),
  });
  try { await nav.start(); } catch (e) { toast(e.message || 'Posizione non disponibile', 5000); stopNavUi(); nav = null; }
}
const pauseFollow = () => { followPausedUntil = Date.now() + 15000; };

function navButtonsHtml() {
  const v = state.settings.navVoice;
  return \`<div class="nav-btns">
    <button type="button" class="btn" id="navVoice" title="Voce o solo vibrazione">\${icon(v ? 'volume' : 'vibrate')} \${v ? 'Voce' : 'Vibra'}</button>
    <button type="button" class="btn" id="navFind" title="Salva una fungaia qui">\${icon('plus')} Fungaia</button>
    <button type="button" class="btn" id="navSkip" title="Salta questa tappa">\${icon('skip')} Salta</button>
    <button type="button" class="btn stop" id="navStop" title="Termina">\${icon('stop')} Fine</button>
  </div>\`;
}
function bindNavButtons() {
  $('#navVoice').onclick = () => { saveSettings({ navVoice: !state.settings.navVoice }); renderVoiceSeg(); nav?.setVoice(state.settings.navVoice); const b = $('#navVoice'); const v = state.settings.navVoice; b.innerHTML = \`\${icon(v ? 'volume' : 'vibrate')} \${v ? 'Voce' : 'Vibra'}\`; };
  $('#navFind').onclick = () => openFindForm('new');
  $('#navSkip').onclick = () => nav?.skip();
  $('#navStop').onclick = () => nav?.stop();
}

function renderNav(v) {
  if (!nav) return;
  const r = v.route;
  if (r && r !== navRouteRef) { // percorso nuovo o ricalcolato
    navRouteRef = r;
    navLayers.eachLayer((l) => { if (l.options?.navRoute) navLayers.removeLayer(l); });
    L.polyline(r.coords.map((c) => [c.lat, c.lon]), { color: '#648381', weight: 6, opacity: 0.85, navRoute: true }).addTo(navLayers);
  }
  navLayers.eachLayer((l) => { if (l.options?.navTrack || l.options?.navMe) navLayers.removeLayer(l); });
  if (v.track.length > 1) L.polyline(v.track.map((p) => [p.lat, p.lon]), { color: '#FFBF46', weight: 4, opacity: 0.9, navTrack: true }).addTo(navLayers);
  if (v.pos) {
    L.marker([v.pos.lat, v.pos.lon], { navMe: true, interactive: false, icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(navLayers);
    if (Date.now() > followPausedUntil) map.panTo([v.pos.lat, v.pos.lon], { animate: true });
  }
  const turnIcon = v.off ? 'x' : v.next?.side === 'left' ? 'left' : v.next?.side === 'right' ? 'right' : 'up';
  const instr = v.off ? 'Fuori percorso: ricalcolo' : !r ? 'Calcolo il percorso…' : v.next && v.next.distM < 250 ? \`\${fmtDist(v.next.distM)} · \${v.next.text}\` : 'Prosegui sul sentiero';
  const tgt = v.target ? \`\${v.returning ? 'Ritorno a' : 'Verso'} \${esc(v.target.label)}\` : '';
  $('#navBar').innerHTML = \`<div class="nav-main"><div class="nav-turn\${v.off ? ' off' : ''}">\${icon(turnIcon)}</div>
    <div class="grow"><div class="nav-instr">\${instr}</div>
      <div class="nav-sub">\${tgt} · <b>\${fmtDist(v.distM)}</b>\${v.etaMin != null ? \` · ~\${fmtDur(v.etaMin)}\` : ''}\${v.n > 1 ? \` · tappa \${Math.min(v.k + 1, v.n)}/\${v.n}\` : ''}</div></div></div>\${navButtonsHtml()}\`;
  bindNavButtons();
}

function stopNavUi() {
  document.body.classList.remove('nav-on');
  $('#navBar').hidden = true;
  map.off('dragstart', pauseFollow);
}

async function finishNav(sum) {
  stopNavUi();
  const meta = navMeta || {};
  nav = null;
  navLayers?.clearLayers();
  await refreshFinds();
  // fungaie salvate durante il giro (ritrovamenti con funghi)
  const found = state.finds.reduce((n, f) => n + (f.visits || []).filter((x) => x.count > 0 && (x.createdAt || x.datetime || '') >= sum.startedAt).length, 0);
  const minutes = Math.max(1, Math.round((new Date(sum.endedAt) - new Date(sum.startedAt)) / 60000));
  const out = {
    id: sum.startedAt, ...meta, ...sum, minutes, found,
    outcome: found ? 'trovato' : null,
  };
  const list = (await kv.get('outings')) || [];
  list.unshift(out);
  await kv.set('outings', list.slice(0, 200));
  renderOutings();
  showOutingDialog(out);
}

function outingSummaryHtml(o) {
  return \`<div class="out-sum">
    <div><b>\${fmtDist(o.distanceM)}</b><span>percorsi</span></div>
    <div><b>\${fmtDur(o.minutes)}</b><span>durata</span></div>
    <div><b>\${o.visited.length}/\${o.targets.length}</b><span>\${o.targets.length > 1 ? 'tappe' : 'spot'}</span></div>
  </div>\`;
}

function showOutingDialog(o) {
  const f = $('#outForm');
  const ask = !o.found;
  f.innerHTML = \`<h2>\${esc(o.title || 'Giro')} \${o.reason === 'completato' ? 'completato' : 'terminato'}</h2>
    \${outingSummaryHtml(o)}
    \${ask ? \`<p>Durante il giro non hai salvato nessuna fungaia. <b>È stato un giro a vuoto?</b></p>
      <div class="btn-row"><button class="btn primary" value="vuoto">Sì, a vuoto</button><button class="btn" value="trovato">No, ho trovato</button></div>
      <button class="btn block" style="margin-top:8px" value="">Decido dopo</button>\`
    : \`<p>Fungaie salvate durante il giro: <b>\${o.found}</b>.</p><button class="btn primary block" value="">Chiudi</button>\`}\`;
  const dlg = $('#outDlg');
  dlg.onclose = async () => {
    const v = dlg.returnValue;
    if (!ask || !v) return;
    if (v === 'vuoto') await markOutingEmpty(o);
    else { await setOutcome(o.id, 'trovato'); openFindForm('new'); }
  };
  dlg.showModal();
}

async function setOutcome(id, outcome) {
  const list = (await kv.get('outings')) || [];
  const o = list.find((x) => x.id === id);
  if (o) { o.outcome = outcome; await kv.set('outings', list); }
  renderOutings();
}

// Giro a vuoto: un'uscita a vuoto nel centro delle tappe visitate (penalizza gli spot vicini come le altre)
async function markOutingEmpty(o) {
  const pts = o.targets.filter((t) => o.visited.includes(t.id));
  const use = pts.length ? pts : o.track.length ? [{ lat: o.track[o.track.length - 1][0], lon: o.track[o.track.length - 1][1] }] : o.targets;
  const lat = use.reduce((a, p) => a + p.lat, 0) / use.length, lon = use.reduce((a, p) => a + p.lon, 0) / use.length;
  await createPlace({ lat, lon, forestChoice: '' }, { datetime: new Date().toISOString(), count: 0, notes: \`\${o.title || 'Giro'} a vuoto\${pts.length ? ': ' + pts.map((p) => p.id).join(', ') : ''}\` });
  await setOutcome(o.id, 'vuoto');
  await refreshFinds();
  toast('Uscita a vuoto registrata: gli spot vicini saranno penalizzati per qualche settimana');
}

async function renderOutings() {
  const el = $('#outingList');
  if (!el) return;
  const list = (await kv.get('outings')) || [];
  setBadge('giri', list.length);
  if (!list.length) {
    el.innerHTML = \`<div class="empty">\${icon('walk')}<div>Qui trovi i riepiloghi dei giri fatti con la guida a piedi.<br>Avviane uno da una zona o da uno spot ("A piedi qui").</div></div>\`;
    return;
  }
  const pill = (o) => (o.outcome === 'trovato' ? \`<span class="pill ok">trovati\${o.found ? ' ' + o.found : ''}</span>\` : o.outcome === 'vuoto' ? '<span class="pill warn">a vuoto</span>' : '<span class="pill">esito da indicare</span>');
  el.innerHTML = list.map((o, i) => \`<div class="card click out-card" data-i="\${i}">
      <div class="row"><div class="t grow">\${esc(o.title || 'Giro')}</div>\${pill(o)}</div>
      <div class="m">\${new Date(o.startedAt).toLocaleString('it-IT', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · \${fmtDist(o.distanceM)} · \${fmtDur(o.minutes)} · \${o.visited.length}/\${o.targets.length} \${o.targets.length > 1 ? 'tappe' : 'spot'}</div>
      <div class="nav-row" data-stop>
        \${!o.outcome ? '<button class="btn small" data-act="vuoto">Era a vuoto</button><button class="btn small" data-act="trovato">Ho trovato</button>' : ''}
        <button class="btn small" data-act="gpx">\${icon('download')} GPX</button>
        <button class="btn small danger" data-act="del">Elimina</button>
      </div>
    </div>\`).join('');
  $$('#outingList .out-card').forEach((c) => {
    const o = list[Number(c.dataset.i)];
    c.onclick = () => showOutingOnMap(o);
    c.querySelectorAll('[data-act]').forEach((b) => b.onclick = async (e) => {
      e.stopPropagation();
      const act = b.dataset.act;
      if (act === 'vuoto') await markOutingEmpty(o);
      else if (act === 'trovato') { await setOutcome(o.id, 'trovato'); openFindForm('new'); }
      else if (act === 'gpx') await shareOrDownload(outingGpx(o), \`giro-\${o.startedAt.slice(0, 10)}.gpx\`);
      else if (act === 'del' && confirm('Eliminare questo riepilogo?')) {
        const l = ((await kv.get('outings')) || []).filter((x) => x.id !== o.id);
        await kv.set('outings', l); renderOutings();
      }
    });
  });
}

function showOutingOnMap(o) {
  if (!navLayers) navLayers = L.layerGroup().addTo(map);
  if (nav) return;
  navLayers.clearLayers();
  const pts = o.track.map((p) => [p[0], p[1]]);
  if (pts.length > 1) L.polyline(pts, { color: '#FFBF46', weight: 5 }).addTo(navLayers);
  o.targets.forEach((t) => L.circleMarker([t.lat, t.lon], { radius: 8, color: o.visited.includes(t.id) ? '#8ACB88' : '#648381', weight: 3, fillOpacity: 0.3 }).bindTooltip(t.label).addTo(navLayers));
  const all = [...pts, ...o.targets.map((t) => [t.lat, t.lon])];
  if (all.length) map.fitBounds(all, { padding: [40, 40], maxZoom: 16 });
  if (innerWidth < 900) setSheet('peek');
}

function outingGpx(o) {
  const x = (s) => String(s).replace(/[<&>"]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;', '"': '&quot;' }[c]));
  const wpts = o.targets.map((t) => \`<wpt lat="\${t.lat}" lon="\${t.lon}"><name>\${x(t.label)}</name></wpt>\`).join('\\n');
  const trk = o.track.map((p) => \`<trkpt lat="\${p[0]}" lon="\${p[1]}">\${p[2] ? \`<time>\${new Date(p[2]).toISOString()}</time>\` : ''}</trkpt>\`).join('');
  return \`<?xml version="1.0" encoding="UTF-8"?>\\n<gpx version="1.1" creator="Cerca Porcini" xmlns="http://www.topografix.com/GPX/1/1">\\n\${wpts}\\n<trk><name>\${x(o.title || 'Giro')}</name><trkseg>\${trk}</trkseg></trk>\\n</gpx>\\n\`;
}

// ---------------------------------------------------------------- tab e pannello`);
console.log('ok');
