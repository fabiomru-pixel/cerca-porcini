import { DEFAULT_SETTINGS, TILE_LAYERS, GROUPS, SPECIES, FORESTS, APP_VERSION } from './config.js';
import { kv, finds as fdb, photos as pdb } from './db.js';
import { icon } from './icons.js';
import { runAnalysis } from './analysis.js';
import { buildGpx, shareOrDownload, download } from './gpx.js';
import {
  createPlace, addVisit, updateVisit, updatePlace, deleteFind, listFinds, processPending, computeLearn,
  normalizeFind, placeSummary, visitOffset, predictPlace, migrateFinds, AGES, STATES,
} from './finds.js';
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
  map.on('popupopen', (e) => {
    const b = e.popup.getElement()?.querySelector('[data-open-place]');
    if (b) b.onclick = () => { map.closePopup(); openView(b.dataset.openPlace); };
  });
  map.on('baselayerchange', (e) => { state.baseLayer = Object.keys(TILE_LAYERS).find((k) => TILE_LAYERS[k].name === e.name); });
  state.baseLayer = 'topo';
  map.on('contextmenu', (e) => {
    state.start = { lat: e.latlng.lat, lon: e.latlng.lng, manual: true };
    renderStart(); drawMe();
    toast('Punto di partenza impostato qui');
  });
}

// cerchio del raggio scelto attorno al punto di partenza (anteprima mentre si trascina la barra)
let radiusCircle = null, radiusFitT = null;
function drawRadiusPreview(km, fit = false) {
  if (radiusCircle) { radiusCircle.remove(); radiusCircle = null; }
  if (!state.start) return;
  radiusCircle = L.circle([state.start.lat, state.start.lon], {
    radius: km * 1000, color: '#2563eb', weight: 2, dashArray: '6 6', fillOpacity: 0.04, interactive: false,
  }).addTo(map);
  if (fit) { clearTimeout(radiusFitT); radiusFitT = setTimeout(() => map.fitBounds(radiusCircle.getBounds(), { padding: [20, 20] }), 250); }
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

// Dettaglio del punteggio: cosa lo alza e cosa lo abbassa
const SOIL_PILL = { umido: 'ok', limite: 'warn', secco: 'bad' };
function scoreBreakdown(s) {
  if (!s.parts) return '';
  const p = s.parts;
  return `<div class="breakdown">
      <span>Luogo <b>${p.luogo}</b>${p.bonus ? ` <span class="muted">(bonus +${p.bonus}%)</span>` : ''}</span>
      <span>Suolo <b>${p.suolo}</b> <b class="pill ${SOIL_PILL[s.soil.cls]}">umidità ${s.soil.theta}%</b></span>
      <span>Timer <b>${p.timer}</b></span>
      <span>Stagione <b>${p.stagione}</b></span>
    </div>`;
}

function spotPopup(s) {
  const prot = s.protected
    ? `<div class="alert ${s.protected.strict ? 'bad' : 'warn'}" style="margin:8px 0 0">${s.protected.strict ? 'Riserva a protezione integrale: raccolta quasi certamente vietata.' : 'Area protetta: verifica il regolamento prima di raccogliere.'}<br><b>${esc(s.protected.name)}</b></div>` : '';
  const kill = s.killers.length ? `<div class="alert warn" style="margin:8px 0 0">Timer fermato da: ${s.killers.join(', ')}</div>` : '';
  const z = s.zone ? (state.analysis?.zones || []).find((x) => x.id === s.zone) : null;
  const zoneTxt = z ? `<div class="small" style="margin:2px 0 4px"><span class="pill zone">Zona ${z.id}</span> ${z.count} spot entro 2 km · giro ~${fmt1(z.tourKm)} km in linea d'aria: ${z.spots.join(' → ')}
    <a class="btn small block" style="margin-top:6px" target="_blank" rel="noopener" href="${zoneTourUrl(z, state.analysis)}">${icon('nav')} Giro della zona su Mapy.com</a></div>` : '';
  const fung = s.fungaia ? `<div class="small" style="margin:2px 0 4px"><span class="pill ok">La tua fungaia</span> ${s.nPos} ritrovament${s.nPos === 1 ? 'o' : 'i'} · ${s.total} esemplari${s.lastVisit ? ` · ultimo ${new Date(s.lastVisit).toLocaleDateString('it-IT')}` : ''}<br>
    <span class="muted">Timer di questa fungaia: ideale ${s.idealDays} giorni dopo la pioggia${s.daysSince != null ? ` · oggi ${s.daysSince} gg dalla pioggia` : ''}</span></div>` : '';
  return `<b>${s.id} · ${s.score}/100</b><br>${fung}${zoneTxt}
    ${s.elevation} m · esposizione ${s.aspectLabel} · pendenza ${s.slope}°<br>
    ${esc(s.forest)}${s.forestType ? ` <span class="muted">(${esc(s.forestType)})</span>` : ''}${s.edge ? ' · margine/radura' : ''}<br>
    <span class="muted">T stimata al suolo ${fmt1(s.tLocal)} °C</span><br>
    ${s.regime ? `<span class="muted">Situazione: ${REGIMES[s.regime].label.toLowerCase()} · pioggia 20 gg ${s.rainTotal} mm</span><br>` : ''}
    ${scoreBreakdown(s)}
    <span class="muted">${s.species.join(', ')}</span>
    ${prot}${kill}
    <div class="small muted" style="margin-top:8px">Portami qui con:</div>
    ${navButtons(s.lat, s.lon, { small: true })}
    ${s.fungaia ? `<button class="btn small block" style="margin-top:6px" data-open-place="${s.placeId}">Apri la scheda della fungaia</button>` : ''}`;
}

function drawAnalysis(a, fit = false) {
  layers.suit.clearLayers(); layers.contours.clearLayers(); layers.prot.clearLayers(); layers.spots.clearLayers();
  if (radiusCircle) { radiusCircle.remove(); radiusCircle = null; } // l'analisi disegna già il suo cerchio
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
  // le tue fungaie, sempre valutate nel punto esatto
  for (const s of a.fungaie || []) {
    const m = L.marker([s.lat, s.lon], {
      zIndexOffset: 500,
      icon: L.divIcon({ className: '', html: `<div class="spot-pin fung" style="background:${scoreColor(s.score)}"><span>${s.score}</span></div>`, iconSize: [34, 34], iconAnchor: [17, 34], popupAnchor: [0, -30] }),
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
    const s = placeSummary(f);
    L.marker([f.lat, f.lon], {
      icon: L.divIcon({ className: '', html: `<div class="find-pin${s.emptyOnly ? ' empty' : ''}">${icon('mushroom').replace('class="i"', 'class="i" style="color:#fff"')}${s.nPos > 1 ? `<span class="n">${s.nPos}</span>` : ''}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] }),
    }).bindTooltip(s.emptyOnly ? 'Uscita a vuoto' : `${s.nPos} ritrovament${s.nPos === 1 ? 'o' : 'i'} · ${s.total} esemplari`).on('click', () => openView(f.id)).addTo(layers.finds);
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
  const r = Math.min(200, Math.max(5, Math.round((s.radiusKm || 50) / 5) * 5));
  $('#radius').value = r; $('#radiusVal').textContent = `${r} km`;
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
    // solo le fungaie con almeno un ritrovamento danno il bonus "vicino a una tua fungaia"
    const productive = state.finds.filter((f) => placeSummary(f).nPos > 0);
    const a = await runAnalysis({
      lat: state.start.lat, lon: state.start.lon, date: $('#date').value,
      settings: state.settings, learn: state.learn, finds: productive,
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

// Link Mapy.com del giro a piedi: dall'auto (andata e ritorno) o dalla tua posizione, tappe negli spot in ordine
// formato: /fnc/v1/route?start=lon,lat&end=lon,lat&waypoints=lon,lat;lon,lat (max 15 tappe intermedie)
function zoneTourUrl(z, a) {
  const pts = z.spots.map((id) => a.spots.find((sp) => sp.id === id)).filter(Boolean);
  if (!pts.length) return null;
  const ll = (p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`;
  const near = (x, km) => x && pts.some((p) => distKm(x, p) <= km);
  let start, end, via;
  if (near(state.car, 5)) { start = state.car; end = state.car; via = pts; }                // anello dall'auto parcheggiata vicino
  else if (near(state.gps, 3)) { start = state.gps; end = pts[pts.length - 1]; via = pts.slice(0, -1); } // sei già sul posto
  else { start = pts[0]; end = pts[pts.length - 1]; via = pts.slice(1, -1); }              // dal primo all'ultimo spot
  const p = new URLSearchParams({ mapset: 'outdoor', routeType: 'foot_hiking', start: ll(start), end: ll(end) });
  if (via.length) p.set('waypoints', via.slice(0, 15).map(ll).join(';'));
  return `https://mapy.com/fnc/v1/route?${p.toString().replace(/%2C/g, ',').replace(/%3B/g, ';')}`;
}

// Zone con più spot vicini: ideali per un giro nella stessa uscita
function zonesCard(a) {
  const zs = (a.zones || []).slice(0, 5);
  if (!zs.length) return a.scan ? '<p class="small muted">Nessuna zona con più spot entro 2 km: gli spot migliori sono sparsi.</p>' : '';
  return `<h3>Zone migliori per un giro</h3>
    ${zs.map((z) => {
      const first = a.spots.find((sp) => sp.id === z.spots[0]);
      const pts = z.spots.map((id) => a.spots.find((sp) => sp.id === id)).filter(Boolean);
      const startTxt = state.car && pts.some((p) => distKm(state.car, p) <= 5) ? 'ad anello dalla tua auto'
        : state.gps && pts.some((p) => distKm(state.gps, p) <= 3) ? 'dalla tua posizione' : `da ${z.spots[0]} a ${z.spots[z.spots.length - 1]}`;
      return `<div class="card click zone-card" data-zone="${z.id}">
      <div class="row"><span class="pill zone">Zona ${z.id}</span><b class="grow">${z.count} spot · migliore ${z.best} · media ${z.mean}</b></div>
      <div class="small muted" style="margin-top:4px">Giro: ${z.spots.join(' → ')} · ~${fmt1(z.tourKm)} km in linea d'aria tra gli spot</div>
      <a class="btn primary block" style="margin-top:8px" target="_blank" rel="noopener" data-stop href="${zoneTourUrl(z, a)}">${icon('nav')} Giro a piedi su Mapy.com</a>
      <div class="small muted" style="margin-top:4px">Percorso su sentieri ${startTxt}, tappe ${z.spots.join(', ')}. In auto fino al primo spot (${z.spots[0]}):</div>
      <div data-stop>${first ? navButtons(first.lat, first.lon, { small: true }) : ''}</div>
    </div>`;
    }).join('')}`;
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
      ${soilLine(a)}
    </div>`;
}

// Umidità del suolo: bilancio pioggia − evaporazione degli ultimi 40 giorni
function soilLine(a) {
  if (a.summary.soilTheta == null) return '';
  const sc = { umido: 0, limite: 0, secco: 0 };
  for (const sp of a.spots) if (sp.soil) sc[sp.soil.cls]++;
  const th = Math.round(a.summary.soilTheta * 100);
  return `<div style="margin-top:8px"><b>Umidità del suolo</b> (pioggia − evaporazione): in valle ${th}%
    <span class="pill ${th >= 50 ? 'ok' : th >= 30 ? 'warn' : 'bad'}">${th >= 50 ? 'umido' : th >= 30 ? 'al limite' : 'secco'}</span><br>
    <span class="muted">Spot: umido ${sc.umido} · al limite ${sc.limite} · secco ${sc.secco}</span></div>
    <div style="margin-top:8px" class="muted">Voto = Luogo × Suolo<sup>1,2</sup> × Timer<sup>0,8</sup> × Stagione<sup>0,5</sup>, ogni fattore da 0 a 1: 100 solo se sono tutti al massimo.</div>`;
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
  if (a.fungaie?.length) {
    const top = a.fungaie[0];
    alerts.push(`<div class="alert ok">Le tue fungaie nel raggio: <b>${a.fungaie.length}</b>, valutate nel punto esatto (segnaposto con bordo marrone). La migliore oggi: <b>${top.id} · ${top.score}/100</b> a ${top.elevation} m. Le trovi in cima alla scheda Spot.</div>`);
  }
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
    ${zonesCard(a)}
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
  $$('.zone-card [data-stop]').forEach((x) => x.addEventListener('click', (e) => e.stopPropagation()));
  $$('.zone-card').forEach((c) => c.onclick = () => {
    const z = a.zones.find((x) => x.id === c.dataset.zone);
    const pts = z.spots.map((id) => a.spots.find((sp) => sp.id === id)).filter(Boolean).map((sp) => [sp.lat, sp.lon]);
    map.fitBounds(pts, { padding: [70, 70], maxZoom: 15 });
    if (innerWidth < 900) setSheet('peek');
  });
  $('#offlineBtn').onclick = saveOfflineArea;
  setBadge('spot', a.spots.length + (a.fungaie?.length || 0));
}

function renderSpots() {
  const a = state.analysis, el = $('#spotList');
  const fung = a?.fungaie || [];
  if (!a || (!a.spots.length && !fung.length)) {
    el.innerHTML = `<div class="empty">${icon('target')}<div>${a ? 'Nessuno spot nel raggio scelto: prova ad allargare il raggio.' : 'Calcola le zone dalla scheda Analisi.'}</div></div>`;
    return;
  }
  const card = (s) => `
    <div class="card click spot${s.fungaia ? ' fung' : ''}" data-id="${s.id}">
      <div class="score" style="background:${scoreColor(s.score)}">${s.score}</div>
      <div>
        <div class="t">${s.id} · ${s.elevation} m · ${s.aspectLabel} ${s.zone ? `<span class="pill zone">Zona ${s.zone}</span> ` : ''}${s.fungaia ? `<span class="pill ok">la tua fungaia · ${s.nPos}×</span>` : s.nearFind ? '<span class="pill ok">vicino a una tua fungaia</span>' : ''}</div>
        <div class="m">${esc(s.forest)}${s.forestType ? ` (${esc(s.forestType)})` : ''}${s.edge ? ' · margine' : ''} · pendenza ${s.slope}° · ${distKm(a.center, s).toFixed(1)} km</div>
        <div class="m">T suolo ${fmt1(s.tLocal)} °C · luogo ${s.place} · tempismo ${s.timing}${s.daysSince != null ? ` · ${s.daysSince} gg da pioggia` : ''}</div>
        ${s.regime ? `<div class="m">${REGIMES[s.regime].label} · pioggia 20 gg ${s.rainTotal} mm${s.soil ? ` · ${esc(s.soil.label.toLowerCase())} (${s.soil.theta}%)` : ''}</div>` : ''}
        ${s.protected ? `<div class="m" style="color:var(--danger)">${s.protected.strict ? 'Riserva integrale' : 'Area protetta'}: ${esc(s.protected.name)}</div>` : ''}
        ${s.killers.length ? `<div class="m" style="color:var(--warn)">Timer fermo: ${s.killers.join(', ')}</div>` : ''}
      </div>
    </div>`;
  el.innerHTML = (fung.length ? `<h3 style="margin-top:4px">Le tue fungaie nel raggio (${fung.length})</h3>${fung.map(card).join('')}<h3>Spot consigliati (${a.spots.length})</h3>` : '')
    + a.spots.map(card).join('');
  $$('.spot', el).forEach((c) => c.onclick = () => {
    const s = [...fung, ...a.spots].find((x) => x.id === c.dataset.id);
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
// Una fungaia è un luogo con più ritrovamenti nel tempo (anche uscite a vuoto).
// form.mode: 'new' (nuova fungaia + primo ritrovamento), 'visit' (nuovo ritrovamento in una fungaia),
//            'editVisit' (modifica ritrovamento), 'editPlace' (modifica posizione/bosco della fungaia)
let form = { mode: 'new', place: null, visit: null };
let newPhotos = [];      // File da aggiungere
let removedPhotos = [];  // id foto da rimuovere
let watchId = null;
let findPos = null;

function stopWatch() { if (watchId != null) navigator.geolocation.clearWatch(watchId); watchId = null; }

function setSeg(id, v) { $$(`#${id} button`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v))); }
function getSeg(id) { return $(`#${id} button[aria-pressed="true"]`)?.dataset.v || null; }
function bindSeg(id, toggle, onChange) {
  $$(`#${id} button`).forEach((b) => b.onclick = () => {
    const was = b.getAttribute('aria-pressed') === 'true';
    setSeg(id, toggle && was ? null : b.dataset.v);
    onChange?.(getSeg(id));
  });
}
function setOutcome(v) {
  setSeg('outcomeSeg', v);
  $('#foundFields').hidden = v === 'empty';
}

async function openFindForm(mode = 'new', placeId = null, visitId = null, { empty = false } = {}) {
  const place = placeId ? normalizeFind(await fdb.get(placeId)) : null;
  const visit = place && visitId ? place.visits.find((v) => v.id === visitId) : null;
  form = { mode, place, visit };
  newPhotos = []; removedPhotos = []; findPos = null;
  const showPos = mode === 'new' || mode === 'editPlace';
  const showVisit = mode !== 'editPlace';
  $('#posGroup').hidden = !showPos;
  $('#forestGroup').hidden = !showPos;
  $('#visitGroup').hidden = !showVisit;
  $('#placeInfo').hidden = showPos;
  $('#findDlgTitle').textContent = { new: 'Nuova fungaia', visit: 'Nuovo ritrovamento', editVisit: 'Modifica ritrovamento', editPlace: 'Modifica fungaia' }[mode];
  $('#findSave').textContent = mode === 'editPlace' ? 'Salva fungaia' : 'Salva';
  $('#fForest').value = place?.forestChoice || place?.forestKey || '';
  if (!showPos && place) {
    const s = placeSummary(place);
    $('#placeInfo').innerHTML = `${icon('pin')} <b>Fungaia</b> · ${place.elevation != null ? place.elevation + ' m · ' + (place.aspectLabel || '') + ' · ' : ''}${s.nPos} ritrovament${s.nPos === 1 ? 'o' : 'i'}`;
  }
  // campi del ritrovamento
  const v = visit || {};
  $('#fDatetime').value = localDT(v.datetime ? new Date(v.datetime) : new Date());
  $('#fTemp').value = v.tempSource === 'manual' ? v.temperature ?? '' : '';
  $('#fTemp').placeholder = v.temperature != null && v.tempSource !== 'manual' ? `${fmt1(v.temperature)} (meteo)` : 'auto';
  $('#fCount').value = v.count > 0 ? v.count : 1;
  $('#fWeight').value = v.weightKg ?? '';
  $('#fSpecies').value = v.species || '';
  setSeg('ageSeg', v.age || null);
  setSeg('stateSeg', v.state || null);
  $('#fNotes').value = v.notes || '';
  setOutcome(visit ? (visit.count > 0 ? 'found' : 'empty') : empty ? 'empty' : 'found');
  $('#fCoords').value = '';
  $('#coordsBox').open = false;
  if (showPos) {
    if (place) { findPos = { lat: place.lat, lon: place.lon, acc: place.accuracy, alt: place.gpsAlt }; renderFindPos(); }
    else {
      $('#findPos').innerHTML = 'Rilevo la posizione GPS…';
      if (navigator.geolocation) {
        watchId = navigator.geolocation.watchPosition((p) => {
          if (!findPos || p.coords.accuracy <= findPos.acc) {
            findPos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, alt: p.coords.altitude };
            renderFindPos();
          }
        }, () => { if (!findPos) $('#findPos').innerHTML = 'GPS non disponibile. <button type="button" class="btn" id="useMapCenter">Usa il centro della mappa</button>'; bindMapCenter(); },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
      }
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
  for (const ph of form.visit?.photos || []) {
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

function readVisitForm() {
  const empty = getSeg('outcomeSeg') === 'empty';
  const tempVal = $('#fTemp').value.trim();
  const manualTemp = tempVal !== '' ? Number(tempVal.replace(',', '.')) : null;
  const count = Math.max(1, Math.round(Number($('#fCount').value) || 1));
  const w = $('#fWeight').value.trim();
  const data = {
    datetime: new Date($('#fDatetime').value).toISOString(),
    count: empty ? 0 : count,
    weightKg: empty || w === '' ? null : Number(w.replace(',', '.')),
    species: empty ? null : $('#fSpecies').value || null,
    age: empty ? null : getSeg('ageSeg'),
    state: empty ? null : getSeg('stateSeg'),
    notes: $('#fNotes').value.trim(),
  };
  if (manualTemp != null && !isNaN(manualTemp)) { data.temperature = manualTemp; data.tempSource = 'manual'; }
  else if (form.visit?.tempSource === 'manual' || !form.visit) { data.tempSource = 'auto'; }
  return data;
}
function readPlaceForm() {
  const forestChoice = $('#fForest').value;
  return {
    lat: findPos.lat, lon: findPos.lon, accuracy: findPos.acc ?? null, gpsAlt: findPos.alt ?? null,
    forestChoice,
    forestKey: forestChoice === 'quercia' || forestChoice === 'faggio' ? forestChoice : null,
    forest: forestChoice ? $('#fForest').selectedOptions[0].textContent : null,
  };
}

async function submitFind() {
  const { mode, place, visit } = form;
  if ((mode === 'new' || mode === 'editPlace') && !findPos) { toast('Posizione non ancora disponibile'); return false; }
  stopWatch();
  let saved;
  if (mode === 'new') saved = await createPlace(readPlaceForm(), readVisitForm(), newPhotos);
  else if (mode === 'visit') saved = await addVisit(place.id, readVisitForm(), newPhotos);
  else if (mode === 'editVisit') saved = await updateVisit(place.id, visit.id, readVisitForm(), newPhotos, removedPhotos);
  else saved = await updatePlace(place.id, readPlaceForm());
  const empty = mode !== 'editPlace' && getSeg('outcomeSeg') === 'empty';
  toast(`${empty ? 'Uscita a vuoto registrata' : mode === 'editPlace' ? 'Fungaia aggiornata' : 'Ritrovamento salvato'}${navigator.onLine ? '' : ' (offline: completo i dati quando torna la rete)'}`, 3500);
  await refreshFinds();
  completePending();
  if (mode !== 'new') setTimeout(() => openView(saved.id), 50);
  return true;
}

async function refreshFinds() {
  state.finds = await listFinds();
  state.learn = computeLearn(state.finds);
  drawFinds(); renderFindList(); renderLearn();
  setBadge('fungaie', state.finds.length);
}

const fmtDay = (iso) => new Date(iso).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
const visitOutcome = (v) => (v.count > 0 ? `<b>${v.count} esemplar${v.count === 1 ? 'e' : 'i'}</b>${v.weightKg ? ` · ${fmt1(v.weightKg)} kg` : ''}` : '<b>Uscita a vuoto</b>');

async function firstPhotoThumb(place) {
  for (const v of placeSummary(place).visits) {
    for (const ph of v.photos || []) {
      const rec = await pdb.get(ph.id);
      if (rec) return URL.createObjectURL(rec.thumb || rec.blob);
    }
  }
  return null;
}

async function renderFindList() {
  const el = $('#findList');
  if (!state.finds.length) {
    el.innerHTML = `<div class="empty">${icon('mushroom')}<div>Nessuna fungaia salvata.<br>Quando trovi porcini premi <b>+ Fungaia</b>: salvo posizione, ora, quantità, età e stato dei funghi e le foto.</div></div>`;
    return;
  }
  const cards = [];
  for (const f of state.finds) {
    const s = placeSummary(f);
    const th = await firstPhotoThumb(f);
    const thumb = th ? `<img class="thumb" src="${th}" alt="">` : `<div class="thumb">${icon('mushroom')}</div>`;
    const pending = f.pending || f.visits.some((v) => v.pending);
    const unsynced = f.visits.some((v) => (v.photos || []).some((p) => !p.driveId)) && state.settings.driveClientId;
    cards.push(`<div class="card click find${s.emptyOnly ? ' empty-place' : ''}" data-id="${f.id}">${thumb}<div>
      <div class="t"><b>${s.emptyOnly ? 'Uscita a vuoto' : `${s.nPos} ritrovament${s.nPos === 1 ? 'o' : 'i'} · ${s.total} esemplari${s.weight ? ` · ${fmt1(s.weight)} kg` : ''}`}</b></div>
      <div class="small muted">Ultimo: ${s.last ? fmtDay(s.last.datetime) : '–'}${s.last?.species ? ' · ' + SPECIES[s.last.species].common : ''}${s.nNeg && !s.emptyOnly ? ` · ${s.nNeg} a vuoto` : ''}</div>
      <div class="small muted">${f.elevation != null ? f.elevation + ' m · ' + (f.aspectLabel || '') : 'quota in calcolo'}${pending ? ' <span class="pill warn">dati in attesa di rete</span>' : ''}${unsynced ? ' <span class="pill">da sincronizzare</span>' : ''}</div>
    </div></div>`);
  }
  el.innerHTML = cards.join('');
  $$('.find', el).forEach((c) => c.onclick = () => openView(c.dataset.id));
}

function visitCard(place, v) {
  const d = new Date(v.datetime);
  const sn = v.snapshot;
  const off = visitOffset(v);
  const adv = sn?.adverse;
  const chips = [
    v.age ? `<span class="pill">${AGES[v.age]}</span>` : '',
    v.state ? `<span class="pill ${v.state === 'sano' ? 'ok' : 'warn'}">${STATES[v.state]}</span>` : '',
    v.species ? `<span class="pill">${SPECIES[v.species].common}</span>` : '',
  ].join(' ');
  const shiftTxt = off ? (off.days === 0 ? 'giorno ideale' : off.days > 0 ? `ideale ~${off.days} gg dopo` : `ideale ~${-off.days} gg prima`) : '';
  return `<div class="card small visit" data-v="${v.id}">
    <div class="row"><div class="grow"><b>${d.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</b> ${d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}</div>
      <button class="btn small" data-edit="${v.id}" style="padding:4px 10px">Modifica</button></div>
    <div style="margin:4px 0">${visitOutcome(v)} ${chips}</div>
    ${sn ? `<div class="muted">T suolo ${fmt1(sn.groundT)} °C · umidità suolo ${sn.soilTheta != null ? Math.round(sn.soilTheta * 100) + '%' : '–'} · pioggia 20 gg ${sn.rainTotal} mm${sn.daysSince != null ? ` · ${sn.daysSince} gg dalla pioggia` : ''}${v.temperature != null ? ` · ${fmt1(v.temperature)} °C quel momento` : ''}</div>` : v.pending ? '<div class="muted">Dati meteo in attesa di rete…</div>' : ''}
    ${off && sn?.daysSince != null ? `<div class="muted">Lettura: ${esc(off.why)} → <b>${shiftTxt}</b> (= ${sn.daysSince + off.days} gg dopo la pioggia)</div>` : ''}
    ${adv?.any ? `<div style="color:var(--warn)">Nei 7 giorni prima: ${[adv.heat && `caldo anomalo (${fmt1(adv.maxT)} °C il ${itDate(adv.maxTDate)})`, adv.wind && `vento forte (${adv.maxWind} km/h il ${itDate(adv.maxWindDate)})`].filter(Boolean).join(', ')}</div>` : ''}
    ${v.notes ? `<div style="white-space:pre-wrap;margin-top:4px">${esc(v.notes)}</div>` : ''}
  </div>`;
}

async function openView(id) {
  const f = normalizeFind(await fdb.get(id));
  if (!f || f.deleted) { $('#viewDlg').close(); return; }
  state.viewId = id;
  const s = placeSummary(f);
  $('#viewTitle').textContent = s.emptyOnly ? 'Uscita a vuoto' : `Fungaia · ${s.nPos} ritrovament${s.nPos === 1 ? 'o' : 'i'}`;
  const imgs = [];
  for (const v of s.visits) for (const ph of v.photos || []) {
    if (imgs.length >= 9) break;
    const rec = await pdb.get(ph.id);
    if (rec) imgs.push(`<img src="${URL.createObjectURL(rec.blob)}" alt="" data-full>`);
  }
  $('#viewBody').innerHTML = `
    ${imgs.length ? `<div class="gallery" style="margin-bottom:12px">${imgs.join('')}</div>` : ''}
    <div class="kpis">
      <div class="kpi"><b>${f.elevation ?? '–'}${f.elevation != null ? ' m' : ''}</b><span>quota</span></div>
      <div class="kpi"><b>${f.aspectLabel || '–'}</b><span>esposizione${f.slope != null ? ` · ${f.slope}°` : ''}</span></div>
      <div class="kpi"><b>${s.total}</b><span>esemplari${s.weight ? ` · ${fmt1(s.weight)} kg` : ''}</span></div>
    </div>
    <div class="card small" style="margin-top:10px" id="predBox">${navigator.onLine ? 'Calcolo il momento ideale per tornare…' : 'Previsione disponibile quando torna la rete.'}</div>
    <h3>Ritrovamenti</h3>
    ${s.visits.map((v) => visitCard(f, v)).join('')}
    <div class="small muted" style="margin:8px 0 4px">${f.lat.toFixed(5)}, ${f.lon.toFixed(5)}${f.forest ? ' · bosco: ' + esc(f.forest) : ''} · Portami qui con:</div>
    ${navButtons(f.lat, f.lon)}
    <div class="nav-row" style="margin-top:10px">
      <button class="btn" id="viewMap">${icon('pin')} Mappa</button>
      <button class="btn" id="viewEditPlace">Modifica luogo</button>
      <button class="btn danger" id="viewDelete">Elimina</button>
    </div>`;
  $$('#viewBody [data-full]').forEach((img) => img.onclick = () => {
    const lb = document.createElement('div'); lb.className = 'lightbox'; lb.innerHTML = `<img src="${img.src}" alt="">`;
    lb.onclick = () => lb.remove(); document.body.appendChild(lb);
  });
  $$('#viewBody [data-edit]').forEach((b) => b.onclick = () => { $('#viewDlg').close(); openFindForm('editVisit', f.id, b.dataset.edit); });
  $('#viewDelete').onclick = async () => {
    if (!confirm('Eliminare tutta la fungaia con i suoi ritrovamenti? Verrà rimossa anche da Drive alla prossima sincronizzazione.')) return;
    await deleteFind(id); $('#viewDlg').close(); await refreshFinds(); toast('Fungaia eliminata');
  };
  $('#viewMap').onclick = () => { $('#viewDlg').close(); map.setView([f.lat, f.lon], 16); if (innerWidth < 900) setSheet('peek'); };
  $('#viewEditPlace').onclick = () => { $('#viewDlg').close(); openFindForm('editPlace', f.id); };
  $('#viewAdd').onclick = () => { $('#viewDlg').close(); openFindForm('visit', f.id); };
  $('#viewEmpty').onclick = () => { $('#viewDlg').close(); openFindForm('visit', f.id, null, { empty: true }); };
  if (!$('#viewDlg').open) $('#viewDlg').showModal();
  if (navigator.onLine && f.lat != null) renderPrediction(f);
}

async function renderPrediction(f) {
  const box = $('#predBox');
  try {
    const p = await predictPlace(f, state.settings, state.learn);
    if (!$('#viewDlg').open || !box.isConnected) return;
    const today = todayStr();
    const soil = Math.round(p.soilNow * 100);
    let head;
    if (p.next) {
      const st = p.next.from > today ? (p.next.future ? 'con la pioggia prevista' : 'in arrivo') : 'adesso';
      head = `<div style="font-size:16px;font-weight:700">Momento ideale: ${itDate(p.next.from)} → ${itDate(p.next.to)}</div>
        <div>${st === 'adesso' ? '<span class="pill ok">finestra aperta</span> ' : ''}dalla pioggia del ${itDate(p.next.end)} (${p.next.total} mm${p.next.future ? ', prevista' : ''}) + ${p.idealDays} giorni</div>`;
    } else {
      head = '<div style="font-size:16px;font-weight:700">Nessuna finestra aperta</div><div>Nessuna pioggia utile recente né prevista nei prossimi 15 giorni: aspetta la prossima pioggia sopra ' + state.settings.rainEventMm + ' mm.</div>';
    }
    box.innerHTML = `${head}
      <div class="muted" style="margin-top:4px">Umidità del suolo oggi: ${soil}% · tempo ideale dopo la pioggia: ${p.idealDays} giorni (${esc(p.source)})</div>`;
  } catch (e) {
    box.textContent = 'Previsione non disponibile al momento.';
  }
}

let pendingBusy = false;
async function completePending() {
  if (pendingBusy || !navigator.onLine) return;
  pendingBusy = true;
  try {
    const n = await processPending(state.settings);
    if (n) {
      await refreshFinds(); toast(`Dati completati per ${n} fungai${n === 1 ? 'a' : 'e'}`);
      if ($('#viewDlg').open && state.viewId) openView(state.viewId); // aggiorna la scheda aperta
    }
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
    el.innerHTML = '<b>Affinamento personale</b><br><span class="muted">Ogni ritrovamento e ogni uscita a vuoto (con dati meteo completati) adattano finestra termica, timer, umidità del suolo ed esposizione a quello che funziona nelle tue zone.</span>';
    return;
  }
  const sh = (v) => (v > 0 ? '+' : '') + fmt1(v);
  const gg = (v) => `${v >= 0 ? '+' : ''}${v} gg`;
  const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  const expoTxt = ['A', 'B', 'C'].filter((R) => l.expoN[R]).map((R) => {
    const best = l.expo[R].map((v, k) => [v, DIRS[k]]).filter(([v]) => Math.abs(v) >= 0.01).sort((a, b) => b[0] - a[0]);
    const lab = { A: 'secco/caldo', B: 'umido/fresco', C: 'intermedia' }[R];
    return best.length ? `${lab} (${l.expoN[R]}): ${best.map(([v, d]) => `${d} ${v > 0 ? '+' : ''}${Math.round(v * 100)}%`).join(', ')}` : '';
  }).filter(Boolean).join('<br>');
  const soilTxt = l.soilShift ? (l.soilShift < 0 ? `meno severo di ${Math.round(-l.soilShift * 100)} punti di umidità` : `più severo di ${Math.round(l.soilShift * 100)} punti di umidità`) : 'come da regole';
  el.innerHTML = `<b>Affinamento personale</b> · ${l.nPos} ritrovament${l.nPos === 1 ? 'o' : 'i'} · ${l.nNeg} uscit${l.nNeg === 1 ? 'a' : 'e'} a vuoto<br>
    Finestra termica: estivo ${sh(l.caldo.tShift)} °C (${l.caldo.n}) · autunnale ${sh(l.fresco.tShift)} °C (${l.fresco.n})<br>
    Timer (dalla pioggia al giorno ideale): querce/castagni ${gg(l.timer.quercia)} (${l.timerN.quercia}) · faggi/abeti ${gg(l.timer.faggio)} (${l.timerN.faggio})<br>
    Suolo: ${soilTxt} (${l.soilN})${expoTxt ? `<br>Esposizione per situazione:<br>${expoTxt}` : ''}`;
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
  if (state.analysis) { drawAnalysis(state.analysis); renderResults(); } // i giri partono dall'auto
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

  // raggio: mentre trascini vedi il cerchio sulla mappa attorno al punto di partenza
  $('#radius').oninput = (e) => {
    const r = Number(e.target.value);
    $('#radiusVal').textContent = `${r} km`;
    drawRadiusPreview(r, true);
  };
  $('#radius').onchange = (e) => { saveSettings({ radiusKm: Number(e.target.value) }); };
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

  bindSeg('outcomeSeg', false, setOutcome);
  bindSeg('ageSeg', true);
  bindSeg('stateSeg', true);
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
  await migrateFinds(); // fungaie della prima versione -> luogo + ritrovamenti
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
