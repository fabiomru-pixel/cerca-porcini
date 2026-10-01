import { DEFAULT_SETTINGS, RADIUS_OPTIONS, TILE_LAYERS, GROUPS, SPECIES, FORESTS, APP_VERSION } from './config.js';
import { kv, finds as fdb, photos as pdb } from './db.js';
import { icon } from './icons.js';
import { runAnalysis } from './analysis.js';
import { buildGpx, shareOrDownload, download } from './gpx.js';
import { saveFind, deleteFind, listFinds, processPending, computeLearn } from './finds.js';
import { syncDrive } from './drive.js';
import { lon2px, lat2px, distKm, bearing, fmtDist, parseCoords, ASPECT_NAME } from './geo.js';
import { addDays } from './engine.js';
import { REGIMES } from './climate.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const fmt1 = (v) => (v == null || isNaN(v) ? '–' : v.toLocaleString('it-IT', { maximumFractionDigits: 1, minimumFractionDigits: 1 }));
const todayStr = () => new Date().toLocaleDateString('sv-SE');
const itDate = (s) => new Date(s + 'T12:00:00').toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
const localDT = (d = new Date()) => {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 16);
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  gps: null,          // ultima posizione GPS {lat, lon, acc, alt}
  start: null,        // punto di partenza dell'analisi {lat, lon, manual}
  analysis: null,
  finds: [],
  learn: null,
};

// ---------------------------------------------------------------- utilità UI
let toastT;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
}
function progress(text, p) {
  const el = $('#progress');
  if (text == null) { el.hidden = true; return; }
  el.hidden = false; $('#progressText').textContent = text; $('#progressBar').style.width = `${Math.round((p || 0) * 100)}%`;
}
async function saveSettings(patch) {
  Object.assign(state.settings, patch);
  await kv.set('settings', state.settings);
}
const scoreColor = (s) => (s >= 70 ? '#15803d' : s >= 50 ? '#65a30d' : s >= 35 ? '#ca8a04' : '#9a6b4f');

// ---------------------------------------------------------------- tema
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('cp-theme', t); } catch { /* storage non disponibile */ }
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  $('#themeBtn').innerHTML = icon(t === 'auto' ? 'auto' : dark ? 'moon' : 'sun');
  $$('#themeSeg button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.v === t));
  document.querySelector('meta[name="theme-color"]').content = dark ? '#161c19' : '#2f6d3c';
}

// ---------------------------------------------------------------- mappa
let map, layers = {};
function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: true }).setView([43.77, 11.25], 9);
  L.control.zoom({ position: 'topright' }).addTo(map);
  const bases = {};
  for (const [k, l] of Object.entries(TILE_LAYERS)) bases[l.name] = layers[k] = L.tileLayer(l.url, l.opts);
  layers.topo.addTo(map);
  layers.suit = L.layerGroup().addTo(map);
  layers.contours = L.layerGroup().addTo(map);
  layers.prot = L.layerGroup().addTo(map);
  layers.spots = L.layerGroup().addTo(map);
  layers.finds = L.layerGroup().addTo(map);
  layers.me = L.layerGroup().addTo(map);
  layers.car = L.layerGroup().addTo(map);
  L.control.layers(bases, {
    'Idoneità (calore)': layers.suit,
    'Fascia di quota': layers.contours,
    'Aree protette': layers.prot,
    'Spot consigliati': layers.spots,
    'Le mie fungaie': layers.finds,
  }, { position: 'topright' }).addTo(map);
  map.on('baselayerchange', (e) => { state.baseLayer = Object.keys(TILE_LAYERS).find((k) => TILE_LAYERS[k].name === e.name); });
  state.baseLayer = 'topo';
  map.on('contextmenu', (e) => {
    state.start = { lat: e.latlng.lat, lon: e.latlng.lng, manual: true };
    renderStart(); drawMe();
    toast('Punto di partenza impostato qui');
  });
}

function drawMe() {
  layers.me.clearLayers();
  if (state.gps) {
    L.circle([state.gps.lat, state.gps.lon], { radius: state.gps.acc || 30, color: '#2563eb', weight: 1, fillOpacity: 0.08 }).addTo(layers.me);
    L.marker([state.gps.lat, state.gps.lon], { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false }).addTo(layers.me);
  }
  if (state.start?.manual) {
    L.circleMarker([state.start.lat, state.start.lon], { radius: 8, color: '#7c3aed', weight: 3, fillOpacity: 0.3 }).bindTooltip('Partenza').addTo(layers.me);
  }
}

// Pulsanti "naviga con…": sul telefono ogni link apre direttamente l'app, se installata
function navButtons(lat, lon, { walk = false, small = false } = {}) {
  const from = state.gps;
  const cls = small ? 'btn small nav-btn' : 'btn nav-btn';
  const links = [];
  if (!walk) links.push(['Waze', `https://waze.com/ul?ll=${lat},${lon}&navigate=yes`]);
  links.push(['Google Maps', `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=${walk ? 'walking' : 'driving'}`]);
  links.push(['Mapy.com', `https://mapy.com/fnc/v1/route?${from ? `start=${from.lon},${from.lat}&` : ''}end=${lon},${lat}&routeType=${walk ? 'foot_hiking' : 'car_fast'}`]);
  return `<div class="nav-row">${links.map(([n, u]) => `<a class="${cls}" target="_blank" rel="noopener" href="${u}">${n}</a>`).join('')}</div>`;
}

function spotPopup(s) {
  const prot = s.protected
    ? `<div class="alert ${s.protected.strict ? 'bad' : 'warn'}" style="margin:8px 0 0">${s.protected.strict ? 'Riserva a protezione integrale: raccolta quasi certamente vietata.' : 'Area protetta: verifica il regolamento prima di raccogliere.'}<br><b>${esc(s.protected.name)}</b></div>` : '';
  const kill = s.killers.length ? `<div class="alert warn" style="margin:8px 0 0">Timer fermato da: ${s.killers.join(', ')}</div>` : '';
  return `<b>${s.id} · ${s.score}/100</b><br>
    ${s.elevation} m · esposizione ${s.aspectLabel} · pendenza ${s.slope}°<br>
    ${esc(s.forest)}${s.forestType ? ` <span class="muted">(${esc(s.forestType)})</span>` : ''}${s.edge ? ' · margine/radura' : ''}<br>
    <span class="muted">T stimata al suolo ${fmt1(s.tLocal)} °C · luogo ${s.place} · tempismo ${s.timing}</span><br>
    ${s.regime ? `<span class="muted">Situazione: ${REGIMES[s.regime].label.toLowerCase()} · pioggia 20 gg ${s.rainTotal} mm</span><br>` : ''}
    <span class="muted">${s.species.join(', ')}</span>
    ${prot}${kill}
    <div class="small muted" style="margin-top:8px">Portami qui con:</div>
    ${navButtons(s.lat, s.lon, { small: true })}`;
}

function drawAnalysis(a, fit = false) {
  layers.suit.clearLayers(); layers.contours.clearLayers(); layers.prot.clearLayers(); layers.spots.clearLayers();
  if (!a) return;
  L.imageOverlay(a.overlay.url, a.overlay.bounds, { opacity: 0.55, interactive: false }).addTo(layers.suit);
  L.circle([a.center.lat, a.center.lon], { radius: a.radius * 1000, color: '#64748b', weight: 1.5, dashArray: '6 6', fill: false, interactive: false }).addTo(layers.suit);
  for (const [gk, c] of Object.entries(a.contours)) {
    const col = GROUPS[gk].color;
    for (const l of c.loLines) L.polyline(l, { color: col, weight: 1.6, opacity: 0.9, dashArray: '4 4', interactive: false }).addTo(layers.contours);
    for (const l of c.hiLines) L.polyline(l, { color: col, weight: 2.2, opacity: 0.9, interactive: false }).addTo(layers.contours);
  }
  if (a.protectedFc) {
    L.geoJSON(a.protectedFc, {
      style: (f) => ({ color: /^I[ab]$/i.test(f.properties.iucnCategory || '') ? '#dc2626' : '#f97316', weight: 1.5, fillOpacity: 0.12, dashArray: '3 3' }),
      onEachFeature: (f, l) => l.bindPopup(`<b>${esc(f.properties.siteName)}</b><br>Area protetta (${esc(f.properties.nationalId || '')}, IUCN ${esc(f.properties.iucnCategory || '-')})<br><span class="muted">Controlla il regolamento: la raccolta può essere vietata o limitata.</span>`),
    }).addTo(layers.prot);
  }
  for (const s of a.spots) {
    const m = L.marker([s.lat, s.lon], {
      icon: L.divIcon({ className: '', html: `<div class="spot-pin" style="background:${scoreColor(s.score)}${s.protected ? ';border-color:#dc2626' : ''}"><span>${s.score}</span></div>`, iconSize: [34, 34], iconAnchor: [17, 34], popupAnchor: [0, -30] }),
    }).bindPopup(spotPopup(s), { minWidth: 260, maxWidth: 300 });
    m.spotId = s.id;
    m.addTo(layers.spots);
  }
  if (fit && a.spots.length) map.fitBounds(L.latLngBounds(a.spots.map((s) => [s.lat, s.lon])).pad(0.15));
  else if (fit) map.setView([a.center.lat, a.center.lon], 10);
}

function drawFinds() {
  layers.finds.clearLayers();
  for (const f of state.finds) {
    if (f.lat == null) continue;
    L.marker([f.lat, f.lon], {
      icon: L.divIcon({ className: '', html: `<div class="find-pin">${icon('mushroom').replace('class="i"', 'class="i" style="color:#fff"')}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] }),
    }).on('click', () => openView(f.id)).addTo(layers.finds);
  }
}

// ---------------------------------------------------------------- posizione
function locate({ silent = false, center = false } = {}) {
  if (!navigator.geolocation) { if (!silent) toast('GPS non disponibile'); return; }
  navigator.geolocation.getCurrentPosition((p) => {
    state.gps = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, alt: p.coords.altitude };
    kv.set('lastGps', state.gps);
    if (!state.start || !state.start.manual) state.start = { lat: state.gps.lat, lon: state.gps.lon, manual: false };
    renderStart(); drawMe();
    if (center) map.setView([state.gps.lat, state.gps.lon], Math.max(map.getZoom(), 12));
  }, (e) => {
    if (!silent) toast(e.code === 1 ? 'Permesso di posizione negato' : 'Posizione non disponibile');
    renderStart();
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
}

function renderStart() {
  const s = state.start;
  $('#posText').innerHTML = s
    ? `<b>${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}</b> ${s.manual ? '<span class="pill">scelta sulla mappa</span>' : `<span class="pill ok">GPS ±${Math.round(state.gps?.acc || 0)} m</span>`}`
    : 'Posizione non disponibile: premi il pulsante o tieni premuto sulla mappa.';
}

// ---------------------------------------------------------------- analisi
function renderControls() {
  const s = state.settings;
  const d = $('#date');
  d.min = todayStr(); d.max = addDays(todayStr(), 15);
  if (!d.value || d.value < d.min || d.value > d.max) d.value = todayStr();
  $('#radiusSeg').innerHTML = RADIUS_OPTIONS.map((r) => `<button data-v="${r}" aria-pressed="${r === s.radiusKm}">${r} km</button>`).join('');
  $('#species').value = s.species;
  $('#aspectPref').value = s.aspectPref || 'auto';
  $('#windowDays').value = s.windowDays; $('#windowDaysVal').textContent = `${s.windowDays} gg`;
  $('#gradient').value = s.gradient; $('#gradientVal').textContent = s.gradient.toFixed(2).replace('.', ',');
  for (const k of ['rainMinMm', 'rainEventMm', 'southOffsetM', 'maxSpots']) $('#' + k).value = s[k];
  $('#driveClientId').value = s.driveClientId || '';
}

async function run() {
  if (!state.start) { toast('Serve una posizione di partenza'); locate(); return; }
  if (!navigator.onLine) { toast('Serve la connessione per calcolare. Offline vedi l’ultima analisi salvata.'); return; }
  const btn = $('#runBtn'); btn.disabled = true;
  try {
    const all = await fdb.all();
    const a = await runAnalysis({
      lat: state.start.lat, lon: state.start.lon, date: $('#date').value,
      settings: state.settings, learn: state.learn, finds: all.filter((f) => !f.deleted),
      onStep: (t, p) => progress(t, p),
    });
    state.analysis = a;
    await kv.set('lastAnalysis', a);
    drawAnalysis(a, true);
    renderResults(); renderSpots();
    toast(`${a.spots.length} spot trovati`);
  } catch (e) {
    console.error(e);
    toast('Errore: ' + e.message, 5000);
  } finally {
    progress(null); btn.disabled = false;
  }
}

// Situazione del bosco (A secco/caldo, B umido/fresco, C intermedia) rispetto al clima normale del periodo
function situationCard(a) {
  if (!a.clim) return '';
  const c = a.clim, t = a.tc, s = a.summary;
  const counts = { A: 0, B: 0, C: 0 };
  for (const sp of a.spots) if (sp.regime) counts[sp.regime]++;
  const main = ['A', 'B', 'C'].sort((x, y) => counts[y] - counts[x])[0];
  const tLabel = t.high || t.maxAnom ? '<span class="pill bad">sopra la media</span>' : t.low ? '<span class="pill ok">medio-bassa</span>' : '<span class="pill">nella media</span>';
  return `<h3>Situazione del bosco</h3>
    <div class="card small">
      <div style="font-size:16px;font-weight:700;margin-bottom:4px">${REGIMES[main].label}</div>
      <div>${REGIMES[main].hint}.</div>
      <div style="margin-top:8px">Temperatura in valle ${fmt1(s.meanT)} °C ${tLabel}<br>
        <span class="muted">Normale del periodo ${fmt1(c.normal)} °C (${esc(c.source)}, zona ${esc(c.zoneLabel)}) · elevata oltre ${fmt1(c.high)} °C · massime anomale oltre ${fmt1(c.maxAnom)} °C (ora ${fmt1(s.meanMax)} °C)</span></div>
      <div style="margin-top:6px" class="muted">Spot per situazione (dipende dalla pioggia caduta in ciascuna zona): secco/caldo ${counts.A} · umido/fresco ${counts.B} · intermedia ${counts.C}</div>
    </div>`;
}

function renderResults() {
  const a = state.analysis;
  const el = $('#results');
  if (!a) { el.innerHTML = ''; return; }
  const s = a.summary;
  const maxRain = Math.max(5, ...s.rainSeries.map((r) => r.rain));
  const bars = s.rainSeries.map((r) => `<i title="${r.date}: ${fmt1(r.rain)} mm" style="height:${Math.max(2, (r.rain / maxRain) * 100)}%"></i>`).join('');
  const last = s.lastEpisode;
  const age = Math.round((Date.now() - new Date(a.createdAt)) / 36e5);
  const groups = a.groups.map((g) => {
    const G = GROUPS[g.key];
    const names = g.species.map((k) => SPECIES[k].common).join(', ');
    return `<div class="card band" style="--c:${G.color}">
      <div class="small muted">${esc(G.label)}${g.offSeason ? ' · fuori stagione' : g.weight < 1 ? ' · inizio/fine stagione' : ' · piena stagione'}</div>
      <div class="big">${Math.round(g.band.lo)}–${Math.round(g.band.hi)} m</div>
      <div class="small">Target ${g.band.tMin}–${g.band.tMax} °C al suolo · ${esc(names)}<br><span class="muted">Bosco tipico: ${FORESTS[G.forest].label} (${FORESTS[G.forest].altMin}–${FORESTS[G.forest].altMax} m)</span></div>
    </div>`;
  }).join('');
  const timerRow = (fk) => {
    const t = a.timers?.[fk];
    if (!t) return `<div><b>${FORESTS[fk].label}</b>: timer non avviato (nessuna pioggia sopra soglia).</div>`;
    const status = a.date < t.firstPossible ? 'in attesa' : a.date < t.from ? 'micelio in attivazione' : a.date <= t.to ? '<span class="pill ok">finestra migliore</span>' : 'finestra in chiusura';
    return `<div style="margin-bottom:6px"><b>${FORESTS[fk].label}</b> · ${status}<br>Migliore: <b>${itDate(t.from)} → ${itDate(t.to)}</b> <span class="muted">(primi funghi dal ${itDate(t.firstPossible)}${t.where ? `, pioggia caduta nella zona di ${t.where}` : ', pioggia in valle'})</span></div>`;
  };
  const timerCard = `<div class="card small">${timerRow('quercia')}${timerRow('faggio')}<div class="muted">Il timer parte dall’ultima pioggia sopra ${state.settings.rainEventMm} mm; ogni spot usa la pioggia caduta nella sua zona.</div></div>`;
  const alerts = [];
  if (a.settings.aspectPref && a.settings.aspectPref !== 'auto') {
    alerts.push(`<div class="alert ok">Solo versanti esposti a <b>${ASPECT_NAME[a.settings.aspectPref]}</b> (tolleranza circa ±35°, esclusi i tratti pianeggianti).${a.spots.length < 5 ? ' Pochi spot: prova “Automatica” o un raggio più ampio.' : ''}</div>`);
  }
  const wetSpots = a.spots.filter((sp) => sp.rainTotal >= state.settings.rainMinMm).length;
  if (!s.rainOk) alerts.push(`<div class="alert ${wetSpots ? 'warn' : 'bad'}">Pioggia in valle insufficiente: ${fmt1(s.rainTotal)} mm in 20 giorni (servono ${state.settings.rainMinMm} mm). ${wetSpots ? `In quota è piovuto di più: ${wetSpots} spot su ${a.spots.length} superano la soglia.` : 'Nemmeno in quota si arriva alla soglia: condizioni non ancora favorevoli.'}</div>`);
  if (s.meanMax > 30) alerts.push('<div class="alert warn">Caldo estremo in valle (medie delle massime oltre 30 °C): cerca in quota e sui versanti Nord.</div>');
  const killersAll = [...new Set(a.spots.flatMap((sp) => sp.killers))];
  if (killersAll.length) alerts.push(`<div class="alert warn">“Killer” del bosco rilevati dopo l’ultima pioggia in alcune zone: <b>${killersAll.join(', ')}</b>. Lì il timer si ferma.</div>`);
  if (!a.forestChecked) alerts.push('<div class="alert warn">Carta dei boschi Copernicus non raggiungibile: alcuni spot potrebbero cadere fuori dal bosco.</div>');
  const learnN = state.learn?.n || 0;
  el.innerHTML = `
    <h3>Condizioni ${a.date === todayStr() ? 'di oggi' : 'per ' + itDate(a.date)}</h3>
    <div class="kpis">
      <div class="kpi"><b>${fmt1(s.meanT)}°</b><span>T media valle (${a.settings.windowDays} gg)</span></div>
      <div class="kpi"><b>${fmt1(s.meanMax)}° / ${fmt1(s.meanMin)}°</b><span>media max / min</span></div>
      <div class="kpi"><b>${Math.round(s.rainTotal)} mm</b><span>pioggia 20 gg ${s.rainOk ? '<span class="pill ok">ok</span>' : '<span class="pill bad">poca</span>'}</span></div>
    </div>
    <div class="card small" style="margin-top:8px">
      Pioggia giornaliera ultimi 20 giorni (valle)
      <div class="rainbars">${bars}</div>
      <div style="margin-top:6px">${last ? `Ultima pioggia utile: <b>${itDate(last.end)}</b> (${fmt1(last.total)} mm) · <b>${last.daysSince} giorni</b> fa rispetto al giorno scelto` : 'Nessun episodio di pioggia sopra soglia.'}</div>
      <div class="muted">Quota di partenza: ${a.valleyElev} m · gradiente ${a.settings.gradient.toFixed(2).replace('.', ',')} °C/100 m</div>
    </div>
    ${alerts.join('')}
    ${situationCard(a)}
    <h3>Fascia di quota consigliata</h3>
    ${groups}
    <h3>Timer del micelio</h3>
    ${timerCard}
    <div class="legend"><span><i style="background:#16a34a"></i>idoneo autunnale</span><span><i style="background:#ea580c"></i>idoneo estivo</span><span><i style="background:#facc15"></i>marginale</span><span><i style="border:2px solid #dc2626"></i>area protetta</span></div>
    ${learnN ? `<p class="small muted">Regole affinate con ${learnN} ritrovament${learnN === 1 ? 'o' : 'i'} tuoi.</p>` : ''}
    <h3>Esporta</h3>
    <div class="btn-row">
      <button class="btn primary" id="gpxBtn">${icon('download')} GPX per Mapy</button>
      <button class="btn" id="offlineBtn">${icon('offline')} Salva offline</button>
    </div>
    <p class="small muted">Analisi del ${new Date(a.createdAt).toLocaleString('it-IT')}${age >= 6 ? ' · <b>ricalcola per dati aggiornati</b>' : ''}</p>`;
  $('#gpxBtn').onclick = exportGpx;
  $('#offlineBtn').onclick = saveOfflineArea;
  setBadge('spot', a.spots.length);
}

function renderSpots() {
  const a = state.analysis, el = $('#spotList');
  if (!a || !a.spots.length) {
    el.innerHTML = `<div class="empty">${icon('target')}<div>${a ? 'Nessuno spot nel raggio scelto: prova ad allargare il raggio.' : 'Calcola le zone dalla scheda Analisi.'}</div></div>`;
    return;
  }
  el.innerHTML = a.spots.map((s) => `
    <div class="card click spot" data-id="${s.id}">
      <div class="score" style="background:${scoreColor(s.score)}">${s.score}</div>
      <div>
        <div class="t">${s.id} · ${s.elevation} m · ${s.aspectLabel} ${s.nearFind ? '<span class="pill ok">vicino a una tua fungaia</span>' : ''}</div>
        <div class="m">${esc(s.forest)}${s.forestType ? ` (${esc(s.forestType)})` : ''}${s.edge ? ' · margine' : ''} · pendenza ${s.slope}° · ${distKm(a.center, s).toFixed(1)} km</div>
        <div class="m">T suolo ${fmt1(s.tLocal)} °C · luogo ${s.place} · tempismo ${s.timing}${s.daysSince != null ? ` · ${s.daysSince} gg da pioggia` : ''}</div>
        ${s.regime ? `<div class="m">${REGIMES[s.regime].label} · pioggia 20 gg ${s.rainTotal} mm</div>` : ''}
        ${s.protected ? `<div class="m" style="color:var(--danger)">${s.protected.strict ? 'Riserva integrale' : 'Area protetta'}: ${esc(s.protected.name)}</div>` : ''}
        ${s.killers.length ? `<div class="m" style="color:var(--warn)">Timer fermo: ${s.killers.join(', ')}</div>` : ''}
      </div>
    </div>`).join('');
  $$('.spot', el).forEach((c) => c.onclick = () => {
    const s = a.spots.find((x) => x.id === c.dataset.id);
    map.setView([s.lat, s.lon], 15);
    layers.spots.eachLayer((m) => { if (m.spotId === s.id) m.openPopup(); });
    if (innerWidth < 900) setSheet('peek');
  });
}

function setBadge(tab, n) {
  const b = $(`.tab[data-tab="${tab}"] .badge`);
  if (b) { b.textContent = n; b.hidden = !n; }
}

async function exportGpx() {
  const fs = state.finds;
  const gpx = buildGpx(state.analysis, fs, { car: state.car });
  const r = await shareOrDownload(gpx, `porcini-${state.analysis?.date || todayStr()}.gpx`);
  if (r === 'downloaded') toast('GPX scaricato: aprilo con Mapy.com (Le mie mappe → Importa)', 4000);
}

// ---------------------------------------------------------------- mappe offline
function tileUrl(tpl, z, x, y, subs) {
  const s = subs ? subs[Math.abs(x + y) % subs.length] : '';
  return tpl.replace('{s}', s).replace('{z}', z).replace('{x}', x).replace('{y}', y);
}
async function saveOfflineArea() {
  const a = state.analysis;
  if (!a) return;
  if (!navigator.onLine) { toast('Sei offline'); return; }
  const layer = TILE_LAYERS[state.baseLayer] || TILE_LAYERS.topo;
  const subs = layer.opts.subdomains ? layer.opts.subdomains.split('') : null;
  const want = new Set();
  const addArea = (lat, lon, km, zooms) => {
    const dLat = km / 111.32, dLon = km / (111.32 * Math.cos((lat * Math.PI) / 180));
    for (const z of zooms) {
      const x0 = Math.floor(lon2px(lon - dLon, z) / 256), x1 = Math.floor(lon2px(lon + dLon, z) / 256);
      const y0 = Math.floor(lat2px(lat + dLat, z) / 256), y1 = Math.floor(lat2px(lat - dLat, z) / 256);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) want.add(`${z}/${x}/${y}`);
    }
  };
  addArea(a.center.lat, a.center.lon, Math.min(a.radius, 30), [9, 10, 11]);
  for (const s of a.spots.slice(0, 20)) addArea(s.lat, s.lon, 1.2, [12, 13, 14, 15]);
  for (const f of state.finds.filter((f) => distKm(a.center, f) <= a.radius)) addArea(f.lat, f.lon, 0.8, [13, 14, 15]);
  const list = [...want].slice(0, 800);
  const cache = await caches.open('cp-tiles-v2');
  let done = 0;
  progress('Salvo le mappe per l’uso offline…', 0);
  const worker = async () => {
    while (list.length) {
      const [z, x, y] = list.shift().split('/').map(Number);
      const url = tileUrl(layer.url, z, x, y, subs);
      try {
        if (!(await cache.match(url))) {
          const res = await fetch(url, { mode: 'cors' });
          if (res.ok) await cache.put(url, res);
        }
      } catch { /* salta la tile */ }
      done++;
      progress(`Salvo le mappe per l’uso offline… ${done}/${Math.min(800, want.size)}`, done / Math.min(800, want.size));
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  progress(null);
  toast(`Area di lavoro salvata (${done} riquadri di mappa). Spot e fungaie restano disponibili offline.`, 4500);
  updateStorageInfo();
}

// ---------------------------------------------------------------- fungaie
let editing = null;      // fungaia in modifica
let newPhotos = [];      // File da aggiungere
let removedPhotos = [];  // id foto da rimuovere
let watchId = null;
let findPos = null;

function stopWatch() { if (watchId != null) navigator.geolocation.clearWatch(watchId); watchId = null; }

async function openFindForm(id) {
  editing = id ? await fdb.get(id) : null;
  newPhotos = []; removedPhotos = []; findPos = null;
  $('#findDlgTitle').textContent = editing ? 'Modifica fungaia' : 'Nuova fungaia';
  $('#fDatetime').value = localDT(editing ? new Date(editing.datetime) : new Date());
  $('#fTemp').value = editing?.temperature ?? '';
  $('#fSpecies').value = editing?.species || '';
  $('#fQty').value = editing?.quantity || '';
  $('#fForest').value = editing?.forestKey || editing?.forestChoice || '';
  $('#fNotes').value = editing?.notes || '';
  $('#fCoords').value = '';
  $('#coordsBox').open = false;
  if (editing) {
    findPos = { lat: editing.lat, lon: editing.lon, acc: editing.accuracy, alt: editing.gpsAlt };
    renderFindPos();
  } else {
    $('#findPos').innerHTML = 'Rilevo la posizione GPS…';
    if (navigator.geolocation) {
      watchId = navigator.geolocation.watchPosition((p) => {
        if (!findPos || p.coords.accuracy <= findPos.acc || findPos.fromMap) {
          findPos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, alt: p.coords.altitude };
          renderFindPos();
        }
      }, () => { if (!findPos) $('#findPos').innerHTML = 'GPS non disponibile. <button type="button" class="btn" id="useMapCenter">Usa il centro della mappa</button>'; bindMapCenter(); },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
    }
  }
  await renderGallery();
  $('#findDlg').showModal();
}
function bindMapCenter() {
  const b = $('#useMapCenter');
  if (b) b.onclick = () => { stopWatch(); const c = map.getCenter(); findPos = { lat: c.lat, lon: c.lng, acc: null, fromMap: true }; renderFindPos(); };
}
function renderFindPos() {
  const p = findPos;
  $('#findPos').innerHTML = `<div class="row"><div class="grow">${icon('pin')} <b>${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</b>
    ${p.manual ? '<span class="pill">coordinate inserite</span>' : p.fromMap ? '<span class="pill">centro mappa</span>' : p.acc ? `<span class="pill ${p.acc < 25 ? 'ok' : 'warn'}">±${Math.round(p.acc)} m</span>` : ''}
    <div class="muted">Quota, esposizione e temperatura vengono calcolate in automatico (anche più tardi, se ora sei offline).</div></div>
    <button type="button" class="btn" id="useMapCenter" title="Usa il centro della mappa">${icon('crosshair')}</button></div>`;
  bindMapCenter();
}

async function renderGallery() {
  const g = $('#fGallery');
  const items = [];
  for (const ph of editing?.photos || []) {
    if (removedPhotos.includes(ph.id)) continue;
    const rec = await pdb.get(ph.id);
    if (rec) items.push(`<div class="ph"><img src="${URL.createObjectURL(rec.thumb || rec.blob)}" alt=""><button type="button" data-rm="${ph.id}" aria-label="Rimuovi">×</button></div>`);
  }
  newPhotos.forEach((f, i) => items.push(`<div class="ph"><img src="${URL.createObjectURL(f)}" alt=""><button type="button" data-rmnew="${i}" aria-label="Rimuovi">×</button></div>`));
  items.push(`<div class="add" id="addCam" title="Scatta">${icon('camera')}</div><div class="add" id="addGal" title="Dalla galleria">${icon('image')}</div>`);
  g.innerHTML = items.join('');
  $('#addCam').onclick = () => $('#fCamera').click();
  $('#addGal').onclick = () => $('#fPhotos').click();
  $$('[data-rm]', g).forEach((b) => b.onclick = () => { removedPhotos.push(b.dataset.rm); renderGallery(); });
  $$('[data-rmnew]', g).forEach((b) => b.onclick = () => { newPhotos.splice(Number(b.dataset.rmnew), 1); renderGallery(); });
}

async function submitFind() {
  if (!findPos) { toast('Posizione non ancora disponibile'); return false; }
  stopWatch();
  const tempVal = $('#fTemp').value.trim();
  const manualTemp = tempVal !== '' ? Number(tempVal.replace(',', '.')) : null;
  const forestChoice = $('#fForest').value;
  const base = editing ? { ...editing } : {};
  const moved = !editing || Math.abs(editing.lat - findPos.lat) > 1e-6 || Math.abs(editing.lon - findPos.lon) > 1e-6;
  const dt = new Date($('#fDatetime').value).toISOString();
  const timeChanged = !editing || editing.datetime !== dt;
  const data = {
    ...base,
    lat: findPos.lat, lon: findPos.lon, accuracy: findPos.acc, gpsAlt: findPos.alt ?? null,
    datetime: dt,
    species: $('#fSpecies').value || null,
    quantity: $('#fQty').value.trim(),
    forestChoice,
    forestKey: forestChoice === 'quercia' || forestChoice === 'faggio' ? forestChoice : null,
    forest: forestChoice ? $('#fForest').selectedOptions[0].textContent : null,
    notes: $('#fNotes').value.trim(),
    photos: (base.photos || []).filter((p) => !removedPhotos.includes(p.id)),
  };
  if (manualTemp != null && !isNaN(manualTemp)) { data.temperature = manualTemp; data.tempSource = 'manual'; }
  else if (base.tempSource === 'manual') { data.temperature = null; data.tempSource = 'auto'; }
  data.pending = { ...(base.pending || {}) };
  if (moved) data.pending.terrain = true;
  if (moved || timeChanged || data.tempSource !== 'manual') data.pending.temperature = data.tempSource !== 'manual';
  data.pending.snapshot = true;
  for (const id of removedPhotos) await pdb.del(id);
  const f = await saveFind(data, newPhotos);
  toast(navigator.onLine ? 'Fungaia salvata' : 'Fungaia salvata offline: completo i dati quando torna la rete', 3500);
  await refreshFinds();
  completePending();
  return true;
}

async function refreshFinds() {
  state.finds = await listFinds();
  state.learn = computeLearn(await fdb.all());
  drawFinds(); renderFindList(); renderLearn();
  setBadge('fungaie', state.finds.length);
}

async function renderFindList() {
  const el = $('#findList');
  if (!state.finds.length) {
    el.innerHTML = `<div class="empty">${icon('mushroom')}<div>Nessuna fungaia salvata.<br>Quando trovi porcini premi <b>+ Fungaia</b>: salvo posizione, ora, temperatura e foto.</div></div>`;
    return;
  }
  const cards = [];
  for (const f of state.finds) {
    let thumb = `<div class="thumb">${icon('mushroom')}</div>`;
    if (f.photos?.length) {
      const rec = await pdb.get(f.photos[0].id);
      if (rec) thumb = `<img class="thumb" src="${URL.createObjectURL(rec.thumb || rec.blob)}" alt="">`;
    }
    const d = new Date(f.datetime);
    cards.push(`<div class="card click find" data-id="${f.id}">${thumb}<div>
      <div class="t"><b>${d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' })}</b> · ${d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}</div>
      <div class="small muted">${f.species ? SPECIES[f.species].common + ' · ' : ''}${f.elevation != null ? f.elevation + ' m · ' + (f.aspectLabel || '') : 'quota in calcolo'}${f.temperature != null ? ' · ' + fmt1(f.temperature) + ' °C' : ''}</div>
      <div class="small muted">${f.quantity ? esc(f.quantity) + ' · ' : ''}${f.pending ? '<span class="pill warn">dati in attesa di rete</span>' : ''}${f.photos?.some((p) => !p.driveId) && state.settings.driveClientId ? ' <span class="pill">da sincronizzare</span>' : ''}</div>
    </div></div>`);
  }
  el.innerHTML = cards.join('');
  $$('.find', el).forEach((c) => c.onclick = () => openView(c.dataset.id));
}

async function openView(id) {
  const f = await fdb.get(id);
  if (!f) return;
  const d = new Date(f.datetime);
  $('#viewTitle').textContent = `Fungaia del ${d.toLocaleDateString('it-IT')}`;
  const imgs = [];
  for (const ph of f.photos || []) {
    const rec = await pdb.get(ph.id);
    if (rec) imgs.push(`<img src="${URL.createObjectURL(rec.blob)}" alt="" data-full>`);
  }
  const sn = f.snapshot;
  $('#viewBody').innerHTML = `
    ${imgs.length ? `<div class="gallery" style="margin-bottom:12px">${imgs.join('')}</div>` : ''}
    <div class="kpis">
      <div class="kpi"><b>${f.elevation ?? '–'}${f.elevation != null ? ' m' : ''}</b><span>quota</span></div>
      <div class="kpi"><b>${f.aspectLabel || '–'}</b><span>esposizione${f.slope != null ? ` · ${f.slope}°` : ''}</span></div>
      <div class="kpi"><b>${f.temperature != null ? fmt1(f.temperature) + '°' : '–'}</b><span>temperatura${f.tempSource === 'manual' ? ' (tua)' : f.tempSource === 'auto' ? ' (meteo)' : ''}</span></div>
    </div>
    <div class="card small" style="margin-top:10px">
      <div><b>${d.toLocaleString('it-IT', { dateStyle: 'full', timeStyle: 'short' })}</b></div>
      <div>${f.lat.toFixed(5)}, ${f.lon.toFixed(5)}${f.accuracy ? ` (±${Math.round(f.accuracy)} m)` : ''}</div>
      ${f.species ? `<div>Specie: ${SPECIES[f.species].label} – ${SPECIES[f.species].common}</div>` : ''}
      ${f.quantity ? `<div>Quantità: ${esc(f.quantity)}</div>` : ''}
      ${f.forest ? `<div>Bosco: ${esc(f.forest)}</div>` : ''}
      ${f.notes ? `<div style="margin-top:6px;white-space:pre-wrap">${esc(f.notes)}</div>` : ''}
    </div>
    ${sn ? `<div class="card small"><b>Condizioni nei giorni prima</b><br>
      T media aria ${fmt1(sn.meanT)} °C (stima al suolo ${fmt1(sn.groundT)} °C) · pioggia 20 gg ${sn.rainTotal} mm${sn.daysSince != null ? ` · ${sn.daysSince} giorni dopo la pioggia` : ''}</div>` : ''}
    ${f.pending ? '<div class="alert warn">Alcuni dati verranno completati appena c’è connessione.</div>' : ''}
    <div class="small muted">Portami qui con:</div>
    ${navButtons(f.lat, f.lon)}`;
  $$('#viewBody [data-full]').forEach((img) => img.onclick = () => {
    const lb = document.createElement('div'); lb.className = 'lightbox'; lb.innerHTML = `<img src="${img.src}" alt="">`;
    lb.onclick = () => lb.remove(); document.body.appendChild(lb);
  });
  $('#viewDelete').onclick = async () => {
    if (!confirm('Eliminare questa fungaia? Verrà rimossa anche da Drive alla prossima sincronizzazione.')) return;
    await deleteFind(id); $('#viewDlg').close(); await refreshFinds(); toast('Fungaia eliminata');
  };
  $('#viewMap').onclick = () => { $('#viewDlg').close(); map.setView([f.lat, f.lon], 16); if (innerWidth < 900) setSheet('peek'); };
  $('#viewEdit').onclick = () => { $('#viewDlg').close(); openFindForm(id); };
  $('#viewDlg').showModal();
}

let pendingBusy = false;
async function completePending() {
  if (pendingBusy || !navigator.onLine) return;
  pendingBusy = true;
  try {
    const n = await processPending(state.settings);
    if (n) { await refreshFinds(); toast(`Dati completati per ${n} fungai${n === 1 ? 'a' : 'e'}`); }
  } finally { pendingBusy = false; }
}

async function doSync() {
  if (!state.settings.driveClientId) { switchTab('impostazioni'); $('#driveClientId').focus(); toast('Inserisci prima il Client ID di Google'); return; }
  if (!navigator.onLine) { toast('Sei offline'); return; }
  const btn = $('#syncBtn'); btn.disabled = true;
  try {
    const r = await syncDrive(state.settings, saveSettings, (t) => progress(t, 0.5));
    await refreshFinds();
    renderSyncStatus();
    toast(`Sincronizzato: ${r.total} fungaie, ${r.uploaded} foto caricate`);
  } catch (e) {
    console.error(e);
    const msg = e.name === 'QuotaExceededError' ? 'spazio del browser esaurito: Opzioni → Svuota mappe salvate offline' : (e.message || e.name);
    toast('Sincronizzazione non riuscita: ' + msg, 6000);
  } finally { progress(null); btn.disabled = false; }
}
function renderSyncStatus() {
  const s = state.settings;
  $('#syncStatus').innerHTML = !s.driveClientId
    ? 'Google Drive non configurato (Impostazioni).'
    : s.lastSync ? `Ultima sincronizzazione con Drive: ${new Date(s.lastSync).toLocaleString('it-IT')}` : 'Drive configurato: premi Sincronizza.';
}

function renderLearn() {
  const l = state.learn;
  const el = $('#learnBox');
  if (!l || !l.n) {
    el.innerHTML = '<b>Affinamento personale</b><br><span class="muted">Ogni fungaia salvata (con dati meteo completati) sposta leggermente la finestra termica e il timer verso quello che funziona nelle tue zone.</span>';
    return;
  }
  const sh = (v) => (v > 0 ? '+' : '') + fmt1(v);
  el.innerHTML = `<b>Affinamento personale</b> · ${l.n} ritrovament${l.n === 1 ? 'o' : 'i'} usati<br>
    Estivo: finestra termica ${sh(l.caldo.tShift)} °C (${l.caldo.n}) · Autunnale: ${sh(l.fresco.tShift)} °C (${l.fresco.n})<br>
    Timer querce/castagni ${l.timer.quercia >= 0 ? '+' : ''}${l.timer.quercia} gg (${l.timerN.quercia}) · faggi/abeti ${l.timer.faggio >= 0 ? '+' : ''}${l.timer.faggio} gg (${l.timerN.faggio})`;
}

// ---------------------------------------------------------------- backup
async function exportBackup() {
  const fs = await fdb.all();
  const ps = await pdb.all();
  const toB64 = (b) => new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
  const photos = [];
  for (const p of ps) photos.push({ id: p.id, findId: p.findId, driveId: p.driveId, data: await toB64(p.blob) });
  const blob = new Blob([JSON.stringify({ app: 'cerca-porcini', version: APP_VERSION, exportedAt: new Date().toISOString(), finds: fs, photos })], { type: 'application/json' });
  download(blob, `cerca-porcini-backup-${todayStr()}.json`);
}
async function importBackup(file) {
  const j = JSON.parse(await file.text());
  if (j.app !== 'cerca-porcini') throw new Error('File non valido');
  let n = 0;
  for (const f of j.finds || []) {
    const cur = await fdb.get(f.id);
    if (!cur || (f.updatedAt || '') > (cur.updatedAt || '')) { await fdb.put(f); n++; }
  }
  const { compressImage } = await import('./finds.js');
  for (const p of j.photos || []) {
    if (await pdb.get(p.id)) continue;
    const blob = await (await fetch(p.data)).blob();
    const { thumb } = await compressImage(blob);
    await pdb.put({ id: p.id, findId: p.findId, driveId: p.driveId, blob, thumb });
  }
  await refreshFinds();
  toast(`Importate ${n} fungaie`);
}

async function updateStorageInfo() {
  if (!navigator.storage?.estimate) return;
  const e = await navigator.storage.estimate();
  $('#storageInfo').textContent = `Spazio usato dall’app: ${(e.usage / 1048576).toFixed(1)} MB`;
}

// ---------------------------------------------------------------- auto parcheggiata
let carWatch = null, carHere = null, heading = null, carLine = null;

function drawCar() {
  layers.car.clearLayers(); carLine = null;
  const c = state.car;
  $('#carBtn').classList.toggle('on', !!c);
  if (!c) return;
  L.marker([c.lat, c.lon], {
    icon: L.divIcon({ className: '', html: `<div class="car-pin">${icon('car')}</div>`, iconSize: [34, 34], iconAnchor: [17, 17] }),
  }).on('click', openCar).addTo(layers.car);
  if (carHere) {
    carLine = L.polyline([[carHere.lat, carHere.lon], [c.lat, c.lon]], { color: '#2563eb', weight: 3, dashArray: '8 8', interactive: false }).addTo(layers.car);
  }
}

async function setCar(pos) {
  state.car = { lat: pos.lat, lon: pos.lon, acc: pos.acc ?? null, savedAt: new Date().toISOString() };
  await kv.set('car', state.car);
  drawCar(); renderCar();
  if ($('#carDlg').open) startCarTracking();
  toast('Posizione dell’auto salvata');
}

function onOrientation(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;          // iPhone
  else if (e.absolute && typeof e.alpha === 'number') h = (360 - e.alpha) % 360;        // Android
  if (h == null) return;
  // compensa la rotazione dello schermo
  const so = (screen.orientation && screen.orientation.angle) || 0;
  heading = (h + so) % 360;
  updateCarArrow();
}

function startCarTracking() {
  if (navigator.geolocation && carWatch == null) {
    carWatch = navigator.geolocation.watchPosition((p) => {
      carHere = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };
      state.gps = { ...carHere, alt: p.coords.altitude };
      drawMe(); drawCar(); updateCarArrow();
    }, () => { updateCarArrow(); }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
  }
  addEventListener('deviceorientationabsolute', onOrientation);
  addEventListener('deviceorientation', onOrientation);
}
function stopCarTracking() {
  if (carWatch != null) navigator.geolocation.clearWatch(carWatch);
  carWatch = null; heading = null;
  removeEventListener('deviceorientationabsolute', onOrientation);
  removeEventListener('deviceorientation', onOrientation);
}

const DIR8 = ['Nord', 'Nord-Est', 'Est', 'Sud-Est', 'Sud', 'Sud-Ovest', 'Ovest', 'Nord-Ovest'];
function updateCarArrow() {
  const c = state.car, box = $('#carNav');
  if (!c || !box) return;
  if (!carHere) { box.innerHTML = '<div class="muted small">Cerco il segnale GPS…</div>'; return; }
  const d = distKm(carHere, c), b = bearing(carHere, c);
  const rel = heading == null ? b : (b - heading + 360) % 360;
  const arrived = d * 1000 <= Math.max(15, (carHere.acc || 0));
  box.innerHTML = arrived
    ? `<div class="car-dist">Sei arrivato 🚗</div><div class="muted small">L’auto è entro ${Math.round(Math.max(15, carHere.acc || 0))} m.</div>`
    : `<div class="compass ${heading == null ? 'north' : ''}">
        <svg viewBox="0 0 100 100" style="transform:rotate(${rel}deg)"><path d="M50 6 L78 86 L50 70 L22 86 Z" fill="var(--primary)"/></svg>
        ${heading == null ? '<span class="n">N</span>' : ''}
      </div>
      <div class="car-dist">${fmtDist(d)}</div>
      <div class="small">verso <b>${DIR8[Math.round(b / 45) % 8]}</b> (${Math.round(b)}°) · precisione GPS ±${Math.round(carHere.acc || 0)} m</div>
      <div class="muted small" style="margin-top:4px">${heading == null ? 'Bussola non disponibile: la freccia indica la direzione rispetto al Nord (in alto).' : 'Tieni il telefono in piano davanti a te e segui la freccia.'}</div>`;
}

function renderCar() {
  const c = state.car, body = $('#carBody');
  if (!body) return;
  if (!c) {
    body.innerHTML = `<p>Salva il punto dove hai parcheggiato: nel bosco potrai tornarci seguendo la freccia, anche senza connessione.</p>
      <div class="btn-row">
        <button class="btn primary" id="carSetGps">${icon('crosshair')} Sono all’auto</button>
        <button class="btn" id="carSetMap">${icon('pin')} Centro mappa</button>
      </div>`;
    $('#carSetGps').onclick = () => {
      if (!navigator.geolocation) { toast('GPS non disponibile'); return; }
      toast('Rilevo la posizione…');
      navigator.geolocation.getCurrentPosition((p) => setCar({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }),
        () => toast('Posizione non disponibile: usa “Centro mappa”'), { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    };
    $('#carSetMap').onclick = () => { const m = map.getCenter(); setCar({ lat: m.lat, lon: m.lng }); };
    return;
  }
  const since = new Date(c.savedAt);
  body.innerHTML = `
    <div id="carNav" class="car-nav"></div>
    <div class="small muted" style="margin:10px 0">Auto salvata alle ${since.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })} del ${since.toLocaleDateString('it-IT')} · ${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}</div>
    <div class="small muted">Percorso a piedi con:</div>
    <div id="carRoute"></div>
    <div style="height:8px"></div>
    <div class="nav-row">
      <button class="btn" id="carShow">${icon('pin')} Mappa</button>
      <button class="btn" id="carMove">Sposta qui</button>
      <button class="btn danger" id="carDel">Rimuovi</button>
    </div>`;
  $('#carRoute').innerHTML = navButtons(c.lat, c.lon, { walk: true });
  $('#carShow').onclick = () => {
    $('#carDlg').close();
    const pts = [[c.lat, c.lon]]; if (carHere) pts.push([carHere.lat, carHere.lon]);
    if (pts.length > 1) map.fitBounds(pts, { padding: [60, 60], maxZoom: 17 }); else map.setView(pts[0], 16);
    if (innerWidth < 900) setSheet('peek');
  };
  $('#carMove').onclick = () => {
    if (!carHere) { toast('Aspetto il GPS…'); return; }
    if (confirm('Spostare l’auto nella tua posizione attuale?')) setCar(carHere);
  };
  $('#carDel').onclick = async () => {
    if (!confirm('Rimuovere la posizione dell’auto?')) return;
    state.car = null; await kv.del('car'); drawCar(); renderCar();
  };
  updateCarArrow();
}

async function openCar() {
  if (!carHere && state.gps) carHere = { lat: state.gps.lat, lon: state.gps.lon, acc: state.gps.acc };
  renderCar();
  $('#carDlg').showModal();
  if (state.car) {
    // iPhone: il permesso della bussola va chiesto con un tocco
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      try { await DeviceOrientationEvent.requestPermission(); } catch { /* senza bussola */ }
    }
    startCarTracking();
  }
}

// ---------------------------------------------------------------- tab e pannello
function switchTab(name) {
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', t.dataset.tab === name));
  $$('.tab-body').forEach((b) => { b.hidden = b.dataset.body !== name; });
  if (innerWidth < 900 && $('#panel').dataset.state === 'peek') setSheet('half');
}
function setSheet(st) {
  $('#panel').dataset.state = st; document.body.dataset.sheet = st;
  setTimeout(() => map.invalidateSize(), 300);
}

function bindUI() {
  const tabs = { analisi: ['target', 'Analisi'], spot: ['list', 'Spot'], fungaie: ['mushroom', 'Fungaie'], impostazioni: ['settings', 'Opzioni'] };
  $$('.tab').forEach((t) => {
    const [ic, lb] = tabs[t.dataset.tab];
    t.innerHTML = `${icon(ic)}<span>${lb}${t.dataset.tab === 'spot' || t.dataset.tab === 'fungaie' ? '<span class="badge" hidden></span>' : ''}</span>`;
    t.onclick = () => switchTab(t.dataset.tab);
  });
  $('#sheetHandle').onclick = () => {
    const st = $('#panel').dataset.state;
    setSheet(st === 'peek' ? 'half' : st === 'half' ? 'full' : 'peek');
  };
  $('#carBtn').innerHTML = icon('car');
  $('#carBtn').onclick = openCar;
  $('#carClose').innerHTML = icon('x');
  $('#carClose').onclick = () => $('#carDlg').close();
  $('#carDlg').addEventListener('close', stopCarTracking);
  $('#locateBtn').innerHTML = icon('crosshair');
  $('#locateBtn').onclick = () => { state.start = null; locate({ center: true }); };
  $('#usePosBtn').innerHTML = icon('crosshair');
  $('#usePosBtn').onclick = () => { state.start = null; locate({ center: true }); };
  $('#fabFind').innerHTML = `${icon('plus')} Fungaia`;
  $('#fabFind').onclick = () => openFindForm();
  $('#newFindBtn').innerHTML = `${icon('plus')} Nuova fungaia`;
  $('#newFindBtn').onclick = () => openFindForm();
  $('#syncBtn').innerHTML = `${icon('cloud')} Sincronizza`;
  $('#syncBtn').onclick = doSync;
  $('#runBtn').innerHTML = `${icon('play')} Calcola le zone`;
  $('#runBtn').onclick = run;
  $('#findClose').innerHTML = icon('x');
  $('#viewClose').innerHTML = icon('x');
  $('#viewClose').onclick = () => $('#viewDlg').close();

  $('#themeBtn').onclick = async () => {
    const order = ['auto', 'light', 'dark'];
    const t = order[(order.indexOf(state.settings.theme) + 1) % 3];
    await saveSettings({ theme: t }); applyTheme(t);
  };
  $$('#themeSeg button').forEach((b) => b.onclick = async () => { await saveSettings({ theme: b.dataset.v }); applyTheme(b.dataset.v); });

  $('#radiusSeg').onclick = async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    await saveSettings({ radiusKm: Number(b.dataset.v) });
    $$('#radiusSeg button').forEach((x) => x.setAttribute('aria-pressed', x === b));
  };
  $('#species').onchange = (e) => saveSettings({ species: e.target.value });
  $('#aspectPref').onchange = (e) => saveSettings({ aspectPref: e.target.value });
  $('#windowDays').oninput = (e) => { $('#windowDaysVal').textContent = `${e.target.value} gg`; saveSettings({ windowDays: Number(e.target.value) }); };
  $('#gradient').oninput = (e) => { $('#gradientVal').textContent = Number(e.target.value).toFixed(2).replace('.', ','); saveSettings({ gradient: Number(e.target.value) }); };
  for (const k of ['rainMinMm', 'rainEventMm', 'southOffsetM', 'maxSpots']) {
    $('#' + k).onchange = (e) => { const v = Number(e.target.value); if (!isNaN(v) && v >= 0) saveSettings({ [k]: v }); };
  }
  $('#driveClientId').onchange = async (e) => { await saveSettings({ driveClientId: e.target.value.trim(), driveFolderId: '' }); renderSyncStatus(); };
  $('#originHint').textContent = location.origin;

  const applyCoords = () => {
    const c = parseCoords($('#fCoords').value);
    if (!c) { toast('Coordinate non riconosciute: usa ad esempio 43.77123, 11.25561'); return; }
    stopWatch();
    findPos = { lat: c.lat, lon: c.lon, acc: null, manual: true };
    renderFindPos();
    toast('Posizione impostata dalle coordinate');
  };
  $('#fCoordsApply').onclick = applyCoords;
  $('#fCoords').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); applyCoords(); } };

  $('#fPhotos').onchange = (e) => { newPhotos.push(...e.target.files); e.target.value = ''; renderGallery(); };
  $('#fCamera').onchange = (e) => { newPhotos.push(...e.target.files); e.target.value = ''; renderGallery(); };
  $('#findForm').onsubmit = async (e) => {
    if (e.submitter?.value === 'cancel') { stopWatch(); return; }
    e.preventDefault();
    const btn = $('#findSave'); btn.disabled = true;
    try { if (await submitFind()) $('#findDlg').close(); } catch (err) { console.error(err); toast('Errore nel salvataggio: ' + err.message, 5000); }
    finally { btn.disabled = false; }
  };
  $('#findDlg').addEventListener('close', stopWatch);

  $('#exportBtn').onclick = exportBackup;
  $('#importBtn').onclick = () => $('#importFile').click();
  $('#importFile').onchange = async (e) => { try { await importBackup(e.target.files[0]); } catch (err) { toast('Import non riuscito: ' + err.message); } e.target.value = ''; };
  $('#clearTilesBtn').onclick = async () => { await caches.delete('cp-tiles-v2'); toast('Mappe offline eliminate'); updateStorageInfo(); };
  $('#versionInfo').textContent = `Versione ${APP_VERSION}`;

  const net = () => { const on = navigator.onLine; $('#net').textContent = on ? 'online' : 'offline'; $('#net').classList.toggle('off', !on); if (on) completePending(); };
  addEventListener('online', net); addEventListener('offline', net); net();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(state.settings.theme));
}

// ---------------------------------------------------------------- avvio
async function init() {
  const saved = await kv.get('settings');
  state.settings = { ...DEFAULT_SETTINGS, ...(saved || {}) };
  if (!state.settings.driveClientId) state.settings.driveClientId = DEFAULT_SETTINGS.driveClientId;
  applyTheme(state.settings.theme);
  initMap();
  bindUI();
  renderControls();
  renderSyncStatus();
  if (innerWidth < 900) setSheet('half');

  const lastGps = await kv.get('lastGps');
  if (lastGps) { state.gps = lastGps; state.start = { lat: lastGps.lat, lon: lastGps.lon, manual: false }; map.setView([lastGps.lat, lastGps.lon], 10); }
  renderStart(); drawMe();
  state.car = (await kv.get('car')) || null;
  drawCar();

  state.analysis = await kv.get('lastAnalysis');
  if (state.analysis) { drawAnalysis(state.analysis, !lastGps); renderResults(); }
  renderSpots();
  await refreshFinds();
  locate({ silent: true });
  completePending();
  updateStorageInfo();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
}

init().catch((e) => { console.error(e); toast('Errore di avvio: ' + e.message, 6000); });
