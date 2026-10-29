import { DEFAULT_SETTINGS, TILE_LAYERS, GROUPS, SPECIES, FORESTS, APP_VERSION, BLOCK_KM } from './config.js';
import { kv, finds as fdb, photos as pdb } from './db.js';
import { icon } from './icons.js';
import { preciseFix, NATIVE } from './platform.js';
import { createNav, walkMin } from './nav.js';
import { checkUpdate, installUpdate } from './update.js';
import { initSafety, markDirty, markSynced, dirtySince, localBackup, photoToGallery } from './safety.js';
import { runAnalysis } from './analysis.js';
import { buildGpx, shareOrDownload, download } from './gpx.js';
import {
  createPlace, addVisit, updateVisit, updatePlace, deleteFind, listFinds, processPending, computeLearn,
  normalizeFind, placeSummary, visitOffset, predictPlace, migrateFinds, mergeDuplicateEmpties, placeNear, AGES, STATES,
} from './finds.js';
import { syncDrive, hasToken, uploadBackup, listBackups, downloadBackup } from './drive.js';
import { lon2px, lat2px, distKm, bearing, fmtDist, parseCoords, ASPECT_NAME } from './geo.js';
import { addDays } from './engine.js';
import { REGIMES } from './climate.js';
import { harvestBan, HARVEST_LIMITS_URL } from './limits.js';

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
// colore del voto (palette): alto oro, medio verde salice, basso verde acqua (testo chiaro)
const scoreColor = (s) => (s >= 70 ? '#FFBF46' : s >= 40 ? '#8ACB88' : '#648381');
const scoreFg = (s) => (s >= 40 ? '#3d3d45' : '#ffffff');

// ---------------------------------------------------------------- tema
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('cp-theme', t); } catch { /* storage non disponibile */ }
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  $('#themeBtn').innerHTML = icon(t === 'auto' ? 'auto' : dark ? 'moon' : 'sun');
  $$('#themeSeg button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.v === t));
  document.querySelector('meta[name="theme-color"]').content = dark ? '#3a3a41' : '#E4FDE1';
  // app Android: icone della barra di stato chiare sul tema scuro, scure sul tema chiaro
  if (NATIVE) window.Capacitor?.Plugins?.SystemBars?.setStyle?.({ style: dark ? 'DARK' : 'LIGHT' }).catch?.(() => {});
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
  layers.heat = L.layerGroup().addTo(map);
  layers.contours = L.layerGroup().addTo(map);
  layers.prot = L.layerGroup().addTo(map);
  layers.spots = L.layerGroup().addTo(map);
  layers.finds = L.layerGroup().addTo(map);
  layers.me = L.layerGroup().addTo(map);
  layers.car = L.layerGroup().addTo(map);
  L.control.layers(bases, {
    'Idoneità (calore)': layers.suit,
    'Area probabile degli spot': layers.heat,
    'Fascia di quota': layers.contours,
    'Aree protette': layers.prot,
    'Spot consigliati': layers.spots,
    'Le mie fungaie': layers.finds,
  }, { position: 'topright' }).addTo(map);
  // il menu dei livelli vive dentro la mappa e finirebbe sotto la barra di ricerca: mentre è aperto la nascondo
  const lc = document.querySelector('.leaflet-control-layers');
  if (lc) new MutationObserver(() => document.body.classList.toggle('layers-open', lc.classList.contains('leaflet-control-layers-expanded')))
    .observe(lc, { attributes: true, attributeFilter: ['class'] });
  map.on('popupopen', (e) => {
    const b = e.popup.getElement()?.querySelector('[data-open-place]');
    if (b) b.onclick = () => { map.closePopup(); openView(b.dataset.openPlace); };
    const ws = e.popup.getElement()?.querySelector('[data-walk-spot]');
    if (ws) ws.onclick = () => { map.closePopup(); walkToSpot(ws.dataset.walkSpot); };
    const bs = e.popup.getElement()?.querySelector('[data-block-spot]');
    if (bs) bs.onclick = () => blockSpot(bs.dataset.blockSpot);
    const wz = e.popup.getElement()?.querySelector('[data-walk-zone]');
    if (wz) wz.onclick = () => { map.closePopup(); walkZone(wz.dataset.walkZone); };
  });
  map.on('baselayerchange', (e) => { state.baseLayer = Object.keys(TILE_LAYERS).find((k) => TILE_LAYERS[k].name === e.name); });
  state.baseLayer = 'topo';
  map.on('contextmenu', (e) => {
    state.start = { lat: e.latlng.lat, lon: e.latlng.lng, manual: true };
    renderStart(); drawMe();
    toast('Punto di partenza impostato qui');
  });
}

// ---------------------------------------------------------------- ricerca luogo
// Photon (komoot, dati OpenStreetMap): gratuito, pensato anche per i suggerimenti mentre si scrive
const PHOTON = 'https://photon.komoot.io/api/';
function placeLabel(p) {
  const comune = p.city && p.city !== p.name ? p.city : (p.county && p.county !== p.name ? p.county : '');
  return { name: p.name || p.street || '', sub: [comune, p.state].filter(Boolean).join(', ') };
}
function initSearch() {
  const box = $('#search'), inp = $('#searchInput'), list = $('#searchList'), clr = $('#searchClear');
  $('#searchIco').innerHTML = icon('search');
  clr.innerHTML = icon('x');
  let results = [], act = -1, timer = null, ctrl = null;
  const close = () => { list.hidden = true; act = -1; };
  const show = () => {
    list.innerHTML = results.length
      ? results.map((r, i) => `<li data-i="${i}" class="${i === act ? 'act' : ''}">${esc(r.name)}${r.sub ? ` <small>${esc(r.sub)}</small>` : ''}</li>`).join('')
      : '<li class="none">Nessun luogo trovato</li>';
    list.hidden = false;
  };
  const pick = (r) => {
    if (!r) return;
    inp.value = r.sub ? `${r.name}, ${r.sub}` : r.name;
    close(); inp.blur();
    state.start = { lat: r.lat, lon: r.lon, manual: true };
    renderStart(); drawMe();
    map.setView([r.lat, r.lon], Math.max(map.getZoom(), 13), { animate: false });
    // il punto al centro della parte di mappa non coperta dal pannello
    const pr = $('#panel').getBoundingClientRect(), mr = map.getContainer().getBoundingClientRect();
    if (window.innerWidth >= 900) map.panBy([-(pr.right - mr.left) / 2, 0], { animate: false });
    else if (pr.top < mr.bottom) map.panBy([0, (mr.bottom - pr.top) / 2], { animate: false });
    toast(`Punto di partenza: ${r.name}`);
  };
  async function query(q) {
    // coordinate scritte a mano: "43.95, 10.82"
    const m = q.match(/^s*(-?d{1,2}[.,]d+)s*[,;s]s*(-?d{1,3}[.,]d+)s*$/);
    if (m) {
      const lat = Number(m[1].replace(',', '.')), lon = Number(m[2].replace(',', '.'));
      results = [{ name: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, sub: 'coordinate', lat, lon }];
      act = 0; show(); return;
    }
    if (q.trim().length < 3) { results = []; close(); return; }
    ctrl?.abort(); ctrl = new AbortController();
    const c = map.getCenter();
    const url = `${PHOTON}?q=${encodeURIComponent(q)}&limit=8&lat=${c.lat.toFixed(3)}&lon=${c.lng.toFixed(3)}&bbox=6.5,36.5,18.6,47.2`;
    try {
      const j = await (await fetch(url, { signal: ctrl.signal })).json();
      const seen = new Set();
      results = [];
      for (const f of j.features || []) {
        const l = placeLabel(f.properties);
        const key = `${l.name}|${l.sub}`;
        if (!l.name || seen.has(key)) continue;
        seen.add(key);
        results.push({ ...l, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] });
        if (results.length >= 6) break;
      }
      act = -1; show();
    } catch (e) {
      if (e.name === 'AbortError') return;
      list.innerHTML = `<li class="none">${navigator.onLine ? 'Ricerca non disponibile, riprova' : 'Serve la connessione per cercare'}</li>`;
      list.hidden = false;
    }
  }
  inp.addEventListener('input', () => {
    clr.hidden = !inp.value;
    clearTimeout(timer); timer = setTimeout(() => query(inp.value), 280);
  });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!results.length) return;
      e.preventDefault();
      act = (act + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length; show();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results.length) pick(results[Math.max(0, act)]);
      else { clearTimeout(timer); query(inp.value).then(() => results.length && pick(results[0])); }
    } else if (e.key === 'Escape') close();
  });
  inp.addEventListener('focus', () => { if (results.length && inp.value) show(); });
  list.addEventListener('pointerdown', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) { e.preventDefault(); pick(results[Number(li.dataset.i)]); }
  });
  clr.onclick = () => { inp.value = ''; clr.hidden = true; results = []; close(); inp.focus(); };
  document.addEventListener('pointerdown', (e) => { if (!box.contains(e.target)) close(); });
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
    L.marker([state.gps.lat, state.gps.lon], { icon: L.divIcon({ className: '', html: ME_HTML, iconSize: [44, 44], iconAnchor: [22, 22] }), interactive: false }).addTo(layers.me);
    updateMeArrow();
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
  links.push([small ? 'Maps' : 'Google Maps', `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=${walk ? 'walking' : 'driving'}`]);
  links.push([small ? 'Mapy' : 'Mapy.com', `https://mapy.com/fnc/v1/route?${from ? `start=${from.lon},${from.lat}&` : ''}end=${lon},${lat}&routeType=${walk ? 'foot_hiking' : 'car_fast'}`]);
  return `<div class="nav-row">${links.map(([n, u]) => `<a class="${cls}" target="_blank" rel="noopener" href="${u}">${n}</a>`).join('')}</div>`;
}

// Raggiungibilità dello spot dalla strada
function accessText(acc) {
  if (!acc) return '';
  const d = acc.distM < 1000 ? `${acc.distM} m` : `${fmt1(acc.distM / 1000)} km`;
  return `Strada a ${d} (${acc.walkMin} min a piedi)`;
}
// Ultima pioggia arrivata su un timer già avviato
function rainEventText(e, saturated) {
  const d = itDate(e.date);
  if (e.type === 'nuovo') return `Pioggia del ${d} (${e.mm} mm) su suolo ormai secco (${e.theta}%): <b>nuovo timer</b>`;
  if (e.type === 'saturazione') return `<span style="color:var(--warn)">Pioggia del ${d} (${e.mm} mm) su suolo già saturo (${e.theta}%)${saturated ? ': voto ridotto per qualche giorno' : ''}</span>`;
  return `Pioggia del ${d} (${e.mm} mm) su suolo ancora umido (${e.theta}%): <b>rinforzo</b>, finestra più lunga`;
}
// Microclima umido vicino a fossi e impluvi
function microText(m) {
  const where = !m.water ? 'versante riparato' : m.distM < 30 ? 'sul fosso' : `fosso a ${m.distM} m${m.hand ? ` (+${m.hand} m)` : ''}`;
  const air = m.rh != null ? ` · aria ${m.rh}%${m.windMean != null ? `, vento ${m.windMean} km/h` : ''}` : '';
  return `Microclima umido: ${where}${air} · suolo +${m.soilGain}`;
}
// Vento forte dopo la pioggia e penalità del versante
function windText(w) {
  if (!w) return '';
  const list = w.winds.slice(0, 2).map((x) => `${x.name} ${x.days} g (raffiche fino a ${x.max} km/h)`).join(', ');
  return `Vento dopo la pioggia: ${list}${w.penalty >= 3 ? ` → versante penalizzato −${w.penalty}%` : ' → versante poco esposto'}`;
}

// Da dove arriva la pioggia dei giorni passati
function rainSrcText(src) {
  if (!src) return '';
  if (src.type === 'pluviometri') return `Pioggia misurata: pluviometri SIR (${src.stations.map((x) => `${esc(x.n)} ${fmt1(x.km)} km`).join(', ')})`;
  return 'Pioggia stimata: media di 3 modelli meteo (nessun pluviometro vicino)';
}

// Dettaglio del punteggio: cosa lo alza e cosa lo abbassa
const SOIL_PILL = { umido: 'ok', limite: 'warn', secco: 'bad' };
// Timer spiegato: da quale pioggia conto, a che giorno siamo e quando cade il periodo migliore
function timerText(s) {
  const t = s.timerInfo;
  if (!t) return `<div class="timer-info"><b>Timer ${s.parts?.timer ?? ''}</b>: nessuna pioggia utile (almeno ${state.settings.rainEventMm || 10} mm in giorni consecutivi) negli ultimi 20 giorni, nessuna nascita attesa.</div>`;
  const range = (a, b) => (a === b ? itDate(a) : `${itDate(a)} – ${itDate(b)}`);
  const ref = state.analysis?.date || todayStr();
  const status = ref < t.first ? `<span style="color:var(--muted)">troppo presto: i primi porcini dal ${itDate(t.first)}</span>`
    : ref < t.optFrom ? `<span style="color:var(--warn)">in arrivo: possibili già ora, il meglio dal ${itDate(t.optFrom)}</span>`
    : ref <= t.optTo ? '<span style="color:var(--ok)">siamo nel periodo migliore</span>'
    : ref < t.end ? `<span style="color:var(--warn)">finestra in chiusura (fino al ${itDate(t.end)})</span>`
    : '<span style="color:var(--danger)">finestra chiusa: serve una nuova pioggia</span>';
  return `<div class="timer-info"><b>Timer ${s.parts?.timer ?? ''}</b> · ${status}
    <div>Pioggia di riferimento: <b>${range(t.rainFrom, t.rainTo)}</b> (${t.mm} mm${t.weak ? ', sotto i 15 mm: voto −20%' : `, conto dal ${itDate(t.trigger)} quando si superano i 15 mm`}) · oggi è il giorno <b>${t.daysSince}</b></div>
    <div>Periodo migliore: <b>${range(t.optFrom, t.optTo)}</b> · primi porcini possibili dal ${itDate(t.first)} · finestra fino al ${itDate(t.end)}${t.ext ? ` (allungata di ${t.ext} giorni da una pioggia successiva)` : ''}</div>
  </div>`;
}

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

// Divieto di raccolta del giorno (Pistoia, Pescia: venerdì per tutti, martedì per i non residenti)
function banHtml(b, style = '') {
  if (!b) return '';
  if (b.expired) return `<div class="alert small"${style}>Comune di ${esc(b.comune)}: il divieto di raccolta del ${b.day} valeva fino al ${itDate(b.to)}. <a href="${HARVEST_LIMITS_URL}" target="_blank" rel="noopener">Verifica se è stato rinnovato</a>.</div>`;
  return `<div class="alert ${b.all ? 'bad' : 'warn'}"${style}><b>${b.all ? 'Raccolta vietata' : 'Raccolta vietata ai non residenti'} il ${b.day}</b> nel Comune di ${esc(b.comune)}${b.all ? ' (anche per i residenti)' : ''}: rischi la multa. Fino al ${itDate(b.to)} · ${esc(b.act)} · <a href="${HARVEST_LIMITS_URL}" target="_blank" rel="noopener">fonte Regione Toscana</a></div>`;
}

function spotPopup(s) {
  const ban = banHtml(harvestBan(s.lat, s.lon, state.analysis?.date), ' style="margin:8px 0 0"');
  const prot = s.protected
    ? `<div class="alert ${s.protected.strict ? 'bad' : 'warn'}" style="margin:8px 0 0">${s.protected.strict ? 'Riserva integrale: raccolta quasi certamente vietata' : 'Area protetta: verifica il regolamento'} · <b>${esc(s.protected.name)}</b></div>` : '';
  const kill = s.killers.length ? `<div class="alert warn" style="margin:8px 0 0">Timer fermato da: ${s.killers.join(', ')}</div>` : '';
  const z = s.zone ? (state.analysis?.zones || []).find((x) => x.id === s.zone) : null;
  const stale = s.lastRainDays != null && s.lastRainDays > (s.staleDays || 20);
  const rain = s.lastRainDays != null
    ? `<span${stale ? ' style="color:var(--danger)"' : ''}>Pioggia ${itDate(s.lastRainDate)}${stale ? ' (vecchia)' : ''}</span> · ${s.rainTotal} mm in 20 gg`
    : `<span style="color:var(--danger)">Nessuna pioggia utile</span> · ${s.rainTotal} mm in 20 gg`;
  const road = s.access ? ` · strada a ${s.access.distM < 1000 ? s.access.distM + ' m' : fmt1(s.access.distM / 1000) + ' km'} (${s.access.walkMin} min)` : '';
  const pinBg = s.fungaia ? 'var(--charcoal)' : scoreColor(s.score), pinFg = s.fungaia ? 'var(--gold)' : scoreFg(s.score);
  // dettagli: tutto ciò che spiega il voto, a richiesta
  const details = [
    `${esc(s.forest)}${s.edge ? ' · margine o radura' : ''}${s.canopy ? ` · chioma ${s.canopy.mean}%${s.canopy.mean < 60 && s.canopy.thorny !== false ? ' (rada: possibili rovi)' : ''}` : ''}`,
    s.offSeason ? `<span style="color:var(--warn)">Fuori stagione per le specie trovate qui (${esc(s.offSeason.join(', '))}): valutata come uno spot qualsiasi</span>` : '',
    s.fungaia ? `${s.nPos} ritrovament${s.nPos === 1 ? 'o' : 'i'} · ${s.total} esemplari${s.lastVisit ? ` · ultimo ${new Date(s.lastVisit).toLocaleDateString('it-IT')}` : ''}` : '',
    s.micro ? `<span style="color:var(--ok)">${microText(s.micro)}</span>` : '',
    s.nearEmpty ? `<span style="color:var(--warn)">Uscita a vuoto a ${s.nearEmpty.m} m il ${itDate(s.nearEmpty.date)}: voto ridotto</span>` : '',
    s.rainEvent ? rainEventText(s.rainEvent, s.saturated) : '',
    s.wind ? windText(s.wind) : '',
    z ? `Giro zona ${z.id}: ${z.spots.join(' → ')} → ${z.spots[0]} (~${fmt1(z.tourKm)} km)` : '',
  ].filter(Boolean).map((x) => `<div>${x}</div>`).join('');
  return `<div class="pop-head">
      <div class="pop-score" style="background:${pinBg};color:${pinFg}">${s.score}</div>
      <div class="grow"><div class="pop-id">${s.fungaia ? 'La tua fungaia' : `Spot ${s.id}`}${z ? ` <span class="pill zone">Zona ${z.id}</span>` : ''}</div>
        <div class="pop-sub">${s.elevation} m · ${s.aspectLabel} · ${s.slope}°</div></div>
    </div>
    <div class="pop-line">${rain}${road}</div>
    ${ban}${prot}${kill}
    <div class="nav-row" style="margin-top:8px">
      <button class="btn small primary" data-walk-spot="${s.id}">${icon('walk')} A piedi qui</button>
      ${z ? `<button class="btn small primary" data-walk-zone="${z.id}">${icon('walk')} Giro zona ${z.id}</button>` : ''}
    </div>
    ${z ? `<a class="btn small block" style="margin-top:6px" target="_blank" rel="noopener" href="${zoneTourUrl(z, state.analysis)}">${icon('nav')} Giro della zona su Mapy</a>` : ''}
    ${navButtons(s.lat, s.lon, { small: true })}
    <details class="pop-more"><summary>Dettagli</summary>${timerText(s)}${details}${scoreBreakdown(s)}
      ${s.fungaia ? '' : `<button class="btn small block" style="margin-top:8px" data-block-spot="${s.id}">Spot inaccessibile (rovi, recinti…)</button>`}</details>
    ${s.fungaia ? `<button class="btn small block" style="margin-top:6px" data-open-place="${s.placeId}">Apri la scheda della fungaia</button>` : ''}`;
}

function drawAnalysis(a, fit = false) {
  layers.suit.clearLayers(); layers.heat?.clearLayers(); layers.contours.clearLayers(); layers.prot.clearLayers(); layers.spots.clearLayers();
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
  // area probabile attorno a ogni spot: più è intenso il colore, più il punto è promettente
  layers.heat.clearLayers();
  const heatR = L.canvas({ padding: 0.3 });
  const heatColor = (v) => { // da verde salice (meno probabile) a oro e arancio (più probabile)
    const stops = [[0, [138, 203, 136]], [0.6, [255, 191, 70]], [1, [232, 89, 12]]];
    const t = Math.max(0, Math.min(1, v));
    for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) {
      const [a0, c0] = stops[i - 1], [a1, c1] = stops[i], k = (t - a0) / (a1 - a0);
      return `rgb(${c0.map((x, j) => Math.round(x + (c1[j] - x) * k)).join(',')})`;
    }
    return 'rgb(232,89,12)';
  };
  for (const s of a.spots) {
    if (!s.heat) continue;
    const r = Math.max(18, (s.heatCell || 30) * 1.05); // cerchi che si sovrappongono: sfumatura continua
    for (const [la, lo, p] of s.heat) {
      const v = p / 100;
      L.circle([la, lo], { renderer: heatR, radius: r, stroke: false, fillColor: heatColor(v), fillOpacity: 0.03 + 0.32 * Math.pow(v, 1.4), interactive: false }).addTo(layers.heat);
    }
  }
  for (const s of a.spots) {
    const m = L.marker([s.lat, s.lon], {
      icon: L.divIcon({ className: '', html: `<div class="spot-pin" style="background:${scoreColor(s.score)};color:${scoreFg(s.score)}${s.protected ? ';border-color:#dc2626' : ''}"><span>${s.score}</span></div>`, iconSize: [34, 34], iconAnchor: [17, 34], popupAnchor: [0, -30] }),
    }).bindPopup(spotPopup(s), { minWidth: 260, maxWidth: 300, autoPanPaddingTopLeft: [10, 80], autoPanPaddingBottomRight: [10, 110] });
    m.spotId = s.id;
    m.addTo(layers.spots);
  }
  // le tue fungaie, sempre valutate nel punto esatto
  for (const s of a.fungaie || []) {
    const m = L.marker([s.lat, s.lon], {
      zIndexOffset: 500,
      icon: L.divIcon({ className: '', html: `<div class="spot-pin fung"><span>${s.score}</span></div>`, iconSize: [34, 34], iconAnchor: [17, 34], popupAnchor: [0, -30] }),
    }).bindPopup(spotPopup(s), { minWidth: 260, maxWidth: 300, autoPanPaddingTopLeft: [10, 80], autoPanPaddingBottomRight: [10, 110] });
    m.spotId = s.id;
    m.addTo(layers.spots);
  }
  // spazio per la barra di ricerca in alto e per il pannello (basso sul telefono, a sinistra sul computer)
  const pad = innerWidth < 900 ? { paddingTopLeft: [20, 80], paddingBottomRight: [20, 130] } : { paddingTopLeft: [460, 80], paddingBottomRight: [40, 40] };
  if (fit && a.spots.length) map.fitBounds(L.latLngBounds(a.spots.map((s) => [s.lat, s.lon])), pad);
  else if (fit) map.setView([a.center.lat, a.center.lon], 10);
}

function drawFinds() {
  layers.finds.clearLayers();
  for (const f of state.finds) {
    if (f.lat == null) continue;
    const s = placeSummary(f);
    L.marker([f.lat, f.lon], {
      icon: L.divIcon({ className: '', html: `<div class="find-pin${s.emptyOnly ? ' empty' : s.otherOnly ? ' other' : ''}">${icon('mushroom').replace('class="i"', 'class="i" style="color:#fff"')}${s.nPos > 1 ? `<span class="n">${s.nPos}</span>` : ''}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] }),
    }).bindTooltip(s.otherOnly ? 'Altro fungo' : s.emptyOnly ? 'Uscita a vuoto' : `${s.nPos} ritrovament${s.nPos === 1 ? 'o' : 'i'} · ${s.total} esemplari`).on('click', () => openView(f.id)).addTo(layers.finds);
  }
}

// ---------------------------------------------------------------- posizione
function locate({ silent = false, center = false } = {}) {
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
        ? `Posizione molto approssimativa (±${(best.acc / 1000).toFixed(1)} km): attiva il GPS e la posizione "precisa" per l'app nelle impostazioni del telefono`
        : `Posizione approssimativa (±${Math.round(best.acc)} m): il GPS non ha ancora un buon segnale, riprova all'aperto`, 8000);
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

function renderStart() {
  const s = state.start;
  $('#posText').innerHTML = s
    ? `<b>${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}</b> ${s.manual ? '<span class="pill">scelta sulla mappa</span>' : `<span class="pill ${(state.gps?.acc || 0) > 100 ? 'warn' : 'ok'}">GPS ±${Math.round(state.gps?.acc || 0)} m</span>`}`
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
  $('#forestPref').value = s.forestPref || 'auto';
  renderVoiceSeg();
  $('#windowDays').value = s.windowDays; $('#windowDaysVal').textContent = `${s.windowDays} gg`;
  $('#gradient').value = s.gradient; $('#gradientVal').textContent = s.gradient.toFixed(2).replace('.', ',');
  for (const k of ['rainMinMm', 'rainEventMm', 'southOffsetM', 'maxSpots', 'maxWalkMin']) $('#' + k).value = s[k];
  $('#driveClientId').value = s.driveClientId || '';
}

// spot irraggiungibile: tolgo l'area (150 m) da questa e dalle prossime analisi
async function blockSpot(id) {
  const a = state.analysis, s = a?.spots.find((x) => x.id === id);
  if (!s || !confirm(`Segno lo spot ${id} come inaccessibile?\n\nL'area entro ${Math.round(BLOCK_KM * 1000)} m non verrà più proposta. Puoi annullare dalle Opzioni.`)) return;
  map.closePopup();
  state.blocked = [...(state.blocked || []), { lat: s.lat, lon: s.lon, at: new Date().toISOString() }];
  await kv.set('blocked', state.blocked);
  a.spots = a.spots.filter((x) => x.id !== id);
  for (const z of a.zones || []) z.spots = z.spots.filter((x) => x !== id);
  const gone = new Set((a.zones || []).filter((z) => z.spots.length < 2).map((z) => z.id));
  a.zones = (a.zones || []).filter((z) => !gone.has(z.id));
  for (const x of a.spots) if (gone.has(x.zone)) x.zone = null;
  await kv.set('lastAnalysis', a);
  drawAnalysis(a); renderResults(); renderSpots(); renderBlocked();
  toast(`Spot ${id} escluso`);
}

function renderBlocked() {
  const box = $('#blockedInfo');
  if (!box) return;
  const n = (state.blocked || []).length;
  box.hidden = !n;
  if (!n) return;
  box.innerHTML = `<label>Spot inaccessibili esclusi</label><div class="btn-row"><span class="muted small" style="align-self:center">${n} ${n === 1 ? 'area esclusa' : 'aree escluse'}</span><button class="btn small" id="blockedReset">Ripristina</button></div>`;
  $('#blockedReset').onclick = async () => {
    if (!confirm('Ripristinare tutte le aree segnate come inaccessibili? Torneranno alla prossima analisi.')) return;
    state.blocked = []; await kv.set('blocked', []); renderBlocked(); toast('Aree ripristinate');
  };
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
      empties: state.finds.flatMap((f) => (f.visits || []).filter((v) => !(v.count > 0) && v.kind !== 'altro' && v.datetime)
        .map((v) => ({ lat: f.lat, lon: f.lon, date: v.datetime.slice(0, 10) }))),
      blocked: state.blocked || [],
      // tutte le uscite (porcini sì/no, anche con soli altri funghi) per l'indicatore della giornata
      outings: state.finds.flatMap((f) => (f.visits || []).filter((v) => v.datetime)
        .map((v) => ({ lat: f.lat, lon: f.lon, date: v.datetime.slice(0, 10), porcini: v.count > 0 && v.kind !== 'altro' }))),
      onStep: (t, p) => progress(t, p),
    });
    state.analysis = a;
    await kv.set('lastAnalysis', a);
    await saveToHistory(a);
    if (innerWidth < 900) setSheet('peek'); // a calcolo finito si vedono gli spot sulla mappa
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
// punti di una zona: spot (P..) e fungaie (F..)
const zonePts = (z, a) => z.spots.map((id) => a.spots.find((sp) => sp.id === id) || (a.fungaie || []).find((f) => f.id === id)).filter(Boolean);
const zoneCountTxt = (z) => `${z.count} spot${z.fungaie ? ` + ${z.fungaie} tu${z.fungaie === 1 ? 'a fungaia' : 'e fungaie'}` : ''} entro 2 km`;
// Giro ad anello: parte e torna allo spot più vicino alla strada (il primo della zona), dove arrivi in auto
function zoneTourUrl(z, a) {
  const pts = zonePts(z, a);
  if (!pts.length) return null;
  const ll = (p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`;
  const start = pts[0], end = pts[0], via = pts.slice(1);
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
      const first = zonePts(z, a)[0];
      const driveTo = z.parking || first;
      return `<div class="card click zone-card" data-zone="${z.id}">
      <div class="row"><span class="pill zone">Zona ${z.id}</span><b class="grow">${z.count} spot${z.fungaie ? ` + ${z.fungaie} fungai${z.fungaie === 1 ? 'a' : 'e'}` : ''} · migliore ${z.best} · media ${z.mean}</b></div>
      <div class="small muted" style="margin-top:4px">Giro: ${z.spots.join(' → ')} → ${z.spots[0]} · ~${fmt1(z.tourKm)} km in linea d'aria</div>
      <button class="btn primary block" style="margin-top:8px" data-stop data-walk-zone="${z.id}">${icon('walk')} Avvia il giro nell'app</button>
      <a class="btn block" style="margin-top:6px" target="_blank" rel="noopener" data-stop href="${zoneTourUrl(z, a)}">${icon('nav')} Giro a piedi su Mapy</a>
      <div class="small muted" style="margin-top:6px">In auto fino a ${z.spots[0]}:</div>
      <div data-stop>${driveTo ? navButtons(driveTo.lat, driveTo.lon, { small: true }) : ''}</div>
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
      <div style="font-size:16px;font-weight:800;margin-bottom:2px">${REGIMES[main].label}</div>
      <div class="muted">${REGIMES[main].hint}</div>
      <div style="margin-top:8px">Valle ${fmt1(s.meanT)} °C ${tLabel} <span class="muted">· normale ${fmt1(c.normal)} °C</span></div>
      ${soilLine(a)}
    </div>`;
}

// Umidità del suolo: bilancio pioggia − evaporazione degli ultimi 40 giorni
function soilLine(a) {
  if (a.summary.soilTheta == null) return '';
  const th = Math.round(a.summary.soilTheta * 100);
  return `<div style="margin-top:6px">Suolo in valle ${th}% <span class="pill ${th >= 50 ? 'ok' : th >= 30 ? 'warn' : 'bad'}">${th >= 50 ? 'umido' : th >= 30 ? 'al limite' : 'secco'}</span></div>`;
}

// Archivio delle analisi (versione leggera, senza immagini) che Sincronizza carica su Drive
async function saveToHistory(a) {
  const light = {
    id: a.createdAt, createdAt: a.createdAt, date: a.date, center: a.center, radius: a.radius, valleyElev: a.valleyElev,
    settings: { ...a.settings, aspectPref: state.settings.aspectPref, forestPref: state.settings.forestPref, maxWalkMin: state.settings.maxWalkMin, species: state.settings.species },
    summary: { meanT: a.summary.meanT, meanMax: a.summary.meanMax, meanMin: a.summary.meanMin, rainTotal: a.summary.rainTotal, soilTheta: a.summary.soilTheta, lastEpisode: a.summary.lastEpisode, timerEpisode: a.summary.timerEpisode },
    clim: a.clim, tc: a.tc, timers: a.timers, scan: a.scan,
    groups: a.groups.map((g) => ({ key: g.key, species: g.species, band: g.band })),
    spots: a.spots.map(({ heat, ...sp }) => sp), fungaie: a.fungaie || [], zones: a.zones || [], // senza le aree colorate (pesanti)
    app: APP_VERSION, uploaded: false,
  };
  try {
    const h = (await kv.get('analysisHistory')) || [];
    h.unshift(light);
    await kv.set('analysisHistory', h.slice(0, 15));
  } catch (e) { console.warn('archivio analisi', e); }
}

function renderResults() {
  const a = state.analysis;
  const el = $('#results');
  if (!a) { el.innerHTML = ''; return; }
  const s = a.summary;
  const maxRain = Math.max(5, ...s.rainSeries.map((r) => r.rain));
  const bars = s.rainSeries.map((r) => `<i title="${r.date}: ${fmt1(r.rain)} mm" style="height:${Math.max(2, (r.rain / maxRain) * 100)}%"></i>`).join('');
  const last = s.timerEpisode || s.lastEpisode;
  const age = Math.round((Date.now() - new Date(a.createdAt)) / 36e5);
  const groups = a.groups.map((g) => {
    const G = GROUPS[g.key];
    const names = g.species.map((k) => SPECIES[k].common).join(', ');
    return `<div class="card band" style="--c:${G.color}">
      <div class="small muted">${esc(G.label)}${g.offSeason ? ' · fuori stagione' : g.weight < 1 ? ' · inizio/fine stagione' : ' · piena stagione'}</div>
      <div class="big">${Math.round(g.band.lo)}–${Math.round(g.band.hi)} m</div>
      <div class="small">${esc(names)} · ${g.band.tMin}–${g.band.tMax} °C al suolo</div>
    </div>`;
  }).join('');
  const timerRow = (fk) => {
    const t = a.timers?.[fk];
    if (!t) return `<div><b>${FORESTS[fk].label}</b>: timer non avviato (nessuna pioggia sopra soglia).</div>`;
    const status = a.date < t.firstPossible ? 'in attesa' : a.date < t.from ? 'micelio in attivazione' : a.date <= t.to ? '<span class="pill ok">finestra migliore</span>' : 'finestra in chiusura';
    return `<div style="margin-bottom:6px"><b>${FORESTS[fk].label}</b> · ${status}<br>Migliore <b>${itDate(t.from)} → ${itDate(t.to)}</b> <span class="muted">· primi funghi dal ${itDate(t.firstPossible)}</span></div>`;
  };
  const timerCard = `<div class="card small">${timerRow('quercia')}${timerRow('faggio')}</div>`;
  const alerts = [];
  {
    // divieti di raccolta nel giorno dell'analisi (per comune)
    const bans = new Map();
    for (const x of [a.center, ...a.spots, ...(a.fungaie || [])]) {
      const b = harvestBan(x.lat, x.lon, a.date);
      if (!b) continue;
      const k = b.comune + (b.expired ? '-x' : '');
      if (!bans.has(k)) bans.set(k, { b, n: 0 });
      if (x !== a.center) bans.get(k).n++;
    }
    for (const { b, n } of bans.values()) {
      const h = banHtml(b);
      alerts.push(n && !b.expired ? h.replace('</b>', `</b> per ${n} spot/fungaie di questa analisi`) : h);
    }
  }
  {
    const all = [...a.spots, ...(a.fungaie || [])];
    const stale = all.filter((x) => x.lastRainDays == null || x.lastRainDays > (x.staleDays || 20));
    const vd = a.summary.lastRainDays;
    if (stale.length) {
      const hot = a.tc?.high || a.tc?.maxAnom;
      const last = stale.map((x) => x.lastRainDate).filter(Boolean).sort().pop();
      alerts.push(`<div class="alert bad"><b>Ultima pioggia caduta oltre 20 giorni fa</b> per ${stale.length} spot su ${all.length}${last ? ` (l'ultima utile il ${itDate(last)})` : ''}${hot ? ', con caldo sopra la media del periodo' : ''}: il micelio ha quasi certamente smesso di fruttificare, punteggi ridotti ${hot ? 'di circa due terzi' : 'della metà'}.</div>`);
    }
    const ne = a.spots.filter((x) => x.nearEmpty).length;
    if (ne) alerts.push(`<div class="alert warn">${ne} spot sono vicini a tue uscite a vuoto recenti: punteggio ridotto (la penalità svanisce in 3 settimane o se torna a piovere).</div>`);
  }
  if (a.scan?.excludedFar) alerts.push(`<div class="alert ok small">Esclusi ${a.scan.excludedFar} spot buoni ma a più di ${a.scan.maxWalk} minuti a piedi dalla strada più vicina (limite modificabile in Opzioni).</div>`);
  if (a.fungaie?.length) {
    const top = a.fungaie[0];
    alerts.push(`<div class="alert ok">Tue fungaie nel raggio: <b>${a.fungaie.length}</b> · la migliore oggi <b>${top.id} · ${top.score}</b></div>`);
  }
  if (a.settings.forestPref && a.settings.forestPref !== 'auto') {
    alerts.push(`<div class="alert ok">Solo boschi di <b>${a.settings.forestPref === 'quercia' ? 'querce e castagni' : 'faggi e abeti'}</b>.${a.spots.length < 5 ? ' Pochi spot: prova “Misto / automatico” o un raggio più ampio.' : ''}</div>`);
  }
  if (a.settings.aspectPref && a.settings.aspectPref !== 'auto') {
    alerts.push(`<div class="alert ok">Solo versanti esposti a <b>${ASPECT_NAME[a.settings.aspectPref]}</b> (tolleranza circa ±35°, esclusi i tratti pianeggianti).${a.spots.length < 5 ? ' Pochi spot: prova “Automatica” o un raggio più ampio.' : ''}</div>`);
  }
  const wetSpots = a.spots.filter((sp) => sp.rainTotal >= state.settings.rainMinMm).length;
  if (!s.rainOk) alerts.push(`<div class="alert ${wetSpots ? 'warn' : 'bad'}">Pioggia in valle insufficiente: ${fmt1(s.rainTotal)} mm in 20 giorni (servono ${state.settings.rainMinMm} mm). ${wetSpots ? `In quota è piovuto di più: ${wetSpots} spot su ${a.spots.length} superano la soglia.` : 'Nemmeno in quota si arriva alla soglia: condizioni non ancora favorevoli.'}</div>`);
  if (s.meanMax > 30) alerts.push('<div class="alert warn">Caldo estremo in valle (medie delle massime oltre 30 °C): cerca in quota e sui versanti Nord.</div>');
  const killersAll = [...new Set(a.spots.flatMap((sp) => sp.killers))];
  if (killersAll.length) alerts.push(`<div class="alert warn">“Killer” del bosco rilevati dopo l’ultima pioggia in alcune zone: <b>${killersAll.join(', ')}</b>. Lì il timer si ferma.</div>`);
  if (a.forestChecked && a.mapSrc?.forest === 'esri') alerts.push('<div class="alert ok small">Servizio Copernicus non raggiungibile: bosco e case verificati con la carta di riserva <b>Esri Land Cover 2025</b> (10 m). Non distingue latifoglie e conifere (decide la quota) e non valuta la densità della chioma.</div>');
  if (!a.forestChecked) alerts.push('<div class="alert warn"><b>Servizio Copernicus non raggiungibile</b> (manutenzione o guasto del server europeo): bosco, case e paesi non verificati, alcuni spot potrebbero cadere fuori dal bosco o vicino alle case. Riprova più tardi per un’analisi completa; le zone già calcolate restano salvate sul telefono.</div>');
  const learnN = state.learn?.n || 0;
  const di = a.dayIndex;
  let dayHtml = '';
  if (di?.level === 'buona') dayHtml = `<div class="alert ok"><b>Giornata buona</b> · porcini trovati il ${itDate(di.lastPorcini.date)} a ${di.lastPorcini.km} km da qui: il bosco sta producendo.</div>`;
  else if (di?.level === 'senza conferme') dayHtml = '<div class="alert small">Giornata <b>senza conferme</b>: nessuna tua uscita negli ultimi 14 giorni entro 30 km. I voti si basano solo su meteo e terreno.</div>';
  else if (di) {
    const n = di.empty.length;
    dayHtml = `<div class="alert ${di.level === 'bassa' ? 'bad' : 'warn'}"><b>Giornata ${di.level}</b> · ${n} uscit${n === 1 ? 'a' : 'e'} senza porcini negli ultimi 14 giorni entro 30 km (${di.empty.map((e) => itDate(e.date)).join(', ')}): il bosco della zona non sta producendo porcini. Voti ridotti del ${Math.round((1 - di.factor) * 100)}%. Risalgono quando trovi porcini o dopo una nuova pioggia.</div>`;
  }
  el.innerHTML = `
    <h3>Condizioni ${a.date === todayStr() ? 'di oggi' : 'per ' + itDate(a.date)}</h3>
    ${dayHtml}
    <div class="kpis">
      <div class="kpi"><b>${fmt1(s.meanT)}°</b><span>T media valle (${a.settings.windowDays} gg)</span></div>
      <div class="kpi"><b>${fmt1(s.meanMax)}° / ${fmt1(s.meanMin)}°</b><span>media max / min</span></div>
      <div class="kpi"><b>${Math.round(s.rainTotal)} mm</b><span>pioggia 20 gg ${s.rainOk ? '<span class="pill ok">ok</span>' : '<span class="pill bad">poca</span>'}</span></div>
    </div>
    <div class="card small" style="margin-top:8px">
      Pioggia giornaliera ultimi 20 giorni (valle)
      <div class="rainbars">${bars}</div>
      <div style="margin-top:6px">${last ? `Pioggia del timer: <b>${itDate(last.end)}</b> (${fmt1(last.total)} mm${last.weak ? ', sotto i 15 mm: voto −20%' : ''}) · <b>${last.daysSince} giorni</b> fa rispetto al giorno scelto` : 'Nessun episodio di pioggia sopra soglia.'}</div>
    </div>
    ${alerts.join('')}
    ${zonesCard(a)}
    ${situationCard(a)}
    <h3>Fascia di quota consigliata</h3>
    ${groups}
    <h3>Timer del micelio</h3>
    ${timerCard}
    ${learnN ? `<p class="small muted">Regole affinate con ${learnN} ritrovament${learnN === 1 ? 'o' : 'i'} tuoi.</p>` : ''}
    <h3>Esporta</h3>
    <div class="btn-row">
      <button class="btn primary" id="gpxBtn">${icon('download')} GPX per Mapy</button>
      <button class="btn" id="offlineBtn">${icon('offline')} Salva offline</button>
    </div>
    <p class="small muted">Analisi del ${new Date(a.createdAt).toLocaleString('it-IT')}${age >= 6 ? ' · <b>ricalcola per dati aggiornati</b>' : ''}</p>`;
  $('#gpxBtn').onclick = exportGpx;
  $$('.zone-card [data-stop]').forEach((x) => x.addEventListener('click', (e) => e.stopPropagation()));
  $$('.zone-card [data-walk-zone]').forEach((x) => x.addEventListener('click', () => walkZone(x.dataset.walkZone)));
  $$('.zone-card').forEach((c) => c.onclick = () => {
    const z = a.zones.find((x) => x.id === c.dataset.zone);
    const pts = zonePts(z, a).map((p) => [p.lat, p.lon]);
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
      <div class="score" style="background:${scoreColor(s.score)};color:${scoreFg(s.score)}">${s.score}</div>
      <div>
        <div class="t">${s.id} · ${s.elevation} m · ${s.aspectLabel} ${s.zone ? `<span class="pill zone">Zona ${s.zone}</span> ` : ''}${s.fungaia ? `<span class="pill ${s.offSeason ? '' : 'ok'}">tua fungaia${s.offSeason ? ' · fuori stagione' : ''}</span>` : ''}</div>
        <div class="m">${esc(s.forest)} · ${s.slope}° · ${distKm(a.center, s).toFixed(1)} km${s.access ? ` · strada ${s.access.walkMin} min` : ''}</div>
        ${(() => { const b = harvestBan(s.lat, s.lon, a.date); return b && !b.expired ? `<div class="m" style="color:var(${b.all ? '--danger' : '--warn'})">Raccolta vietata il ${b.day}${b.all ? '' : ' ai non residenti'} (Comune di ${esc(b.comune)})</div>` : ''; })()}
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
  for (const s of a.spots.slice(0, 25)) addArea(s.lat, s.lon, 1.2, [12, 13, 14, 15]);
  // zoom 16 sull'area colorata attorno agli spot (la si guarda da vicino, anche senza campo)
  for (const s of a.spots.slice(0, 25)) addArea(s.lat, s.lon, 0.6, [16]);
  for (const f of state.finds.filter((f) => distKm(a.center, f) <= a.radius)) addArea(f.lat, f.lon, 0.8, [13, 14, 15]);
  const MAX_TILES = 2500; // circa 50–80 MB: mappe di tutte le aree colorate fino allo zoom 16
  const list = [...want].slice(0, MAX_TILES);
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
      progress(`Salvo le mappe per l’uso offline… ${done}/${Math.min(MAX_TILES, want.size)}`, done / Math.min(MAX_TILES, want.size));
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  progress(null);
  toast(`Area di lavoro salvata (${done} riquadri di mappa). Spot, aree colorate e fungaie restano disponibili anche senza campo.`, 5000);
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
  $('#porcinoFields').hidden = v !== 'found';
  $('#otherFields').hidden = v !== 'other';
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
  $('#fOtherName').value = v.otherName || '';
  setOutcome(visit ? (visit.kind === 'altro' ? 'other' : visit.count > 0 ? 'found' : 'empty') : empty ? 'empty' : 'found');
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
  const outcome = getSeg('outcomeSeg');
  const empty = outcome === 'empty', other = outcome === 'other';
  const tempVal = $('#fTemp').value.trim();
  const manualTemp = tempVal !== '' ? Number(tempVal.replace(',', '.')) : null;
  const count = Math.max(1, Math.round(Number($('#fCount').value) || 1));
  const w = $('#fWeight').value.trim();
  const data = {
    datetime: new Date($('#fDatetime').value).toISOString(),
    count: empty ? 0 : count,
    weightKg: empty || w === '' ? null : Number(w.replace(',', '.')),
    species: empty || other ? null : $('#fSpecies').value || null,
    age: empty || other ? null : getSeg('ageSeg'),
    state: empty || other ? null : getSeg('stateSeg'),
    kind: other ? 'altro' : null,
    otherName: other ? ($('#fOtherName').value.trim() || 'Altro fungo') : null,
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
  markDirty();
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
const visitOutcome = (v) => (v.kind === 'altro' ? `<b>Altro fungo: ${esc(v.otherName || '')}</b> ×${v.count}${v.weightKg ? ` · ${fmt1(v.weightKg)} kg` : ''}` : v.count > 0 ? `<b>${v.count} esemplar${v.count === 1 ? 'e' : 'i'}</b>${v.weightKg ? ` · ${fmt1(v.weightKg)} kg` : ''}` : '<b>Uscita a vuoto</b>');

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
      <div class="t"><b>${s.otherOnly ? `Altro fungo: ${esc(s.other.map((v) => v.otherName).join(', '))}` : s.emptyOnly ? 'Uscita a vuoto' : `${s.nPos} ritrovament${s.nPos === 1 ? 'o' : 'i'} · ${s.total} esemplari${s.weight ? ` · ${fmt1(s.weight)} kg` : ''}`}</b></div>
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
    ${sn ? `<div class="muted">T suolo ${fmt1(sn.groundT)} °C${sn.subsoil ? ` · terreno 18 cm ${fmt1(sn.subsoil.t18)} °C, 54 cm ${fmt1(sn.subsoil.t54)} °C` : ''} · umidità suolo ${sn.soilTheta != null ? Math.round(sn.soilTheta * 100) + '%' : '–'} · pioggia 20 gg ${sn.rainTotal} mm${sn.daysSince != null ? ` · ${sn.daysSince} gg dalla pioggia` : ''}${v.temperature != null ? ` · ${fmt1(v.temperature)} °C quel momento` : ''}</div>
    ${sn.ver ? `<div class="muted small">${sn.rainSrc?.type === 'pluviometri' ? `Pioggia misurata: pluviometri SIR (${sn.rainSrc.stations.map((x) => esc(x.n)).join(', ')})` : 'Pioggia stimata: media di 3 modelli meteo'}</div>` : '<div class="muted small">Dati meteo da ricalcolare con la nuova versione…</div>'}` : v.pending ? '<div class="muted">Dati meteo in attesa di rete…</div>' : ''}
    ${off && sn?.daysSince != null ? `<div class="muted">Lettura: ${esc(off.why)} → <b>${shiftTxt}</b> (= ${sn.daysSince + off.days} gg dopo la pioggia)</div>` : ''}
    ${adv?.any ? `<div style="color:var(--warn)">Nei 7 giorni prima: ${[adv.heat && `caldo anomalo (${fmt1(adv.maxT)} °C il ${itDate(adv.maxTDate)})`, adv.wind && `vento forte (raffiche ${adv.maxWind} km/h il ${itDate(adv.maxWindDate)})`].filter(Boolean).join(', ')}</div>` : ''}
    ${v.notes ? `<div style="white-space:pre-wrap;margin-top:4px">${esc(v.notes)}</div>` : ''}
  </div>`;
}

async function openView(id) {
  const f = normalizeFind(await fdb.get(id));
  if (!f || f.deleted) { $('#viewDlg').close(); return; }
  state.viewId = id;
  const s = placeSummary(f);
  $('#viewTitle').textContent = s.otherOnly ? 'Altro fungo' : s.emptyOnly ? 'Uscita a vuoto' : `Fungaia · ${s.nPos} ritrovament${s.nPos === 1 ? 'o' : 'i'}`;
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
    await deleteFind(id); $('#viewDlg').close(); await refreshFinds(); markDirty(); toast('Fungaia eliminata');
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
      <div class="muted" style="margin-top:4px">Umidità del suolo oggi: ${soil}% · tempo ideale dopo la pioggia: ${p.idealDays} giorni (${esc(p.source)})</div>
      ${p.rainSrc ? `<div class="muted small" style="margin-top:4px">${rainSrcText(p.rainSrc)}</div>` : ''}`;
  } catch (e) {
    box.textContent = 'Previsione non disponibile al momento.';
  }
}

let pendingBusy = false;
async function completePending() {
  if (pendingBusy || !navigator.onLine) return;
  pendingBusy = true;
  try {
    // uscite a vuoto registrate due volte e giri con soli altri funghi segnati "trovato" (versioni precedenti)
    if (await mergeDuplicateEmpties()) { await refreshFinds(); markDirty(); }
    await fixOutingOutcomes();
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
    await markSynced();
    await refreshFinds();
    renderSyncStatus();
    toast(`Sincronizzato: ${r.total} fungaie, ${r.outings || 0} giri, ${r.uploaded} foto, ${r.analyses || 0} analisi`); renderOutings();
  } catch (e) {
    console.error(e);
    const msg = e.name === 'QuotaExceededError' ? 'spazio del browser esaurito: Opzioni → Svuota mappe salvate offline' : (e.message || e.name);
    toast('Sincronizzazione non riuscita: ' + msg, 6000);
  } finally { progress(null); btn.disabled = false; }
}
async function renderSyncStatus() {
  const s = state.settings;
  const dirty = await dirtySince();
  const local = await kv.get('localBackupAt');
  const ago = dirty ? Math.round((Date.now() - new Date(dirty)) / 36e5) : 0;
  const line = !s.driveClientId
    ? 'Google Drive non configurato (Impostazioni).'
    : s.lastSync ? `Ultima sincronizzazione con Drive: ${new Date(s.lastSync).toLocaleString('it-IT')}` : 'Drive configurato: premi Sincronizza.';
  $('#syncStatus').innerHTML = (dirty
    ? `<div class="alert ${ago >= 24 ? 'bad' : 'warn'}" style="margin:0 0 6px"><b>Modifiche non ancora salvate su Drive</b> ${ago >= 1 ? `da ${ago} or${ago === 1 ? 'a' : 'e'}` : 'da poco'}: premi <b>Sincronizza</b> per metterle al sicuro.</div>` : '')
    + line + (NATIVE && local ? `<br>Copia di sicurezza sul telefono (Documenti/CercaPorcini): ${new Date(local).toLocaleString('it-IT')}` : '');
}

// sincronizzazione automatica: solo se l'accesso a Google è ancora valido (dura circa un'ora dopo "Sincronizza")
async function syncSilently() {
  if (!state.settings.driveClientId || !hasToken() || !navigator.onLine) return;
  await syncDrive(state.settings, saveSettings, () => {});
  await markSynced();
  await refreshFinds(); renderOutings(); renderSyncStatus();
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
async function buildBackup() {
  const fs = await fdb.all();
  const ps = await pdb.all();
  const toB64 = (b) => new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
  const photos = [];
  for (const p of ps) photos.push({ id: p.id, findId: p.findId, driveId: p.driveId, data: await toB64(p.blob) });
  const outings = (await kv.get('outings')) || [];
  return { app: 'cerca-porcini', version: APP_VERSION, exportedAt: new Date().toISOString(), finds: fs, photos, outings };
}
async function exportBackup() {
  const blob = new Blob([JSON.stringify(await buildBackup())], { type: 'application/json' });
  const name = `cerca-porcini-backup-${todayStr()}.json`;
  if (!NATIVE) download(blob, name);
  // copia anche su Drive, così dall'altro dispositivo basta "Importa da Drive"
  if (!state.settings.driveClientId) { if (NATIVE) toast('Configura Google Drive per salvare il backup'); return; }
  try {
    progress('Salvo il backup su Drive…', 0.5);
    const t = new Date(); const pad = (n) => String(n).padStart(2, '0');
    await uploadBackup(state.settings, saveSettings, blob, `cerca-porcini-backup-${todayStr()}-ore${pad(t.getHours())}${pad(t.getMinutes())}-${NATIVE ? 'telefono' : 'sito'}.json`);
    toast('Backup salvato anche su Drive (cartella Cerca Porcini/backup)');
  } catch (e) { toast('Backup su Drive non riuscito: ' + e.message); }
  finally { progress(null); }
}

async function importFromDrive() {
  if (!state.settings.driveClientId) return toast('Configura prima Google Drive (Impostazioni)');
  let list;
  try { progress('Cerco i backup su Drive…', 0.5); list = await listBackups(state.settings, saveSettings); }
  catch (e) { return toast('Drive: ' + e.message); }
  finally { progress(null); }
  const f = $('#outForm');
  f.innerHTML = `<h2>Importa da Drive</h2>
    ${list.length ? `<p class="small muted">Backup salvati con “Esporta backup” (il più recente in alto):</p>
      ${list.map((b) => `<button class="btn block" style="margin-bottom:6px;text-align:left" value="${esc(b.id)}"><b>${new Date(b.modifiedTime).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })}</b> · ${esc(/telefono/.test(b.name) ? 'dal telefono' : /sito/.test(b.name) ? 'dal sito' : b.name)} · ${(Number(b.size || 0) / 1048576).toFixed(1)} MB</button>`).join('')}`
    : `<p>Su Drive non c'è ancora nessun backup. Apri Cerca Porcini sull'altro dispositivo e premi <b>Esporta backup</b>: verrà salvato anche su Drive.</p>`}
    <button class="btn block" value="">Annulla</button>`;
  const dlg = $('#outDlg');
  dlg.onclose = async () => {
    const id = dlg.returnValue; dlg.onclose = null;
    if (!id) return;
    try {
      progress('Scarico il backup da Drive…', 0.5);
      const blob = await downloadBackup(id);
      progress(null);
      await importBackup(blob);
    } catch (e) { progress(null); toast('Import non riuscito: ' + e.message); }
  };
  dlg.returnValue = '';
  dlg.showModal();
}
async function importBackup(file) {
  if (!file) return;
  let j;
  try { j = JSON.parse(await file.text()); } catch { throw new Error('il file scelto non è un backup di Cerca Porcini (.json)'); }
  if (j.app !== 'cerca-porcini') throw new Error('il file scelto non è un backup di Cerca Porcini');
  toast(`Importo ${(j.finds || []).length} fungaie…`);
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
  if (Array.isArray(j.outings) && j.outings.length) {
    const cur = (await kv.get('outings')) || [];
    const ids = new Set(cur.map((o) => o.id));
    await kv.set('outings', [...cur, ...j.outings.filter((o) => !ids.has(o.id))].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || '')));
    renderOutings();
  }
  await refreshFinds();
  markDirty();
  toast(`Importate ${n} fungaie${j.outings?.length ? ` e ${j.outings.length} giri` : ''}`);
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
  $('#posBtn').classList.toggle('car', !!c);
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
  compassAt = Date.now();
  updateCarArrow();
  updateMeArrow();
}

// ---- freccia della posizione (come Google Maps e Mapy): bussola se c'è, altrimenti direzione di marcia
const ME_HTML = '<div class="me-pos"><svg viewBox="0 0 44 44" aria-hidden="true"><path d="M22 4 L35 37 L22 29.5 L9 37 Z"/></svg><div class="dot"></div></div>';
let compassAt = 0, gpsHeading = null, gpsHeadingAt = 0, shownDeg = null;
function setGpsHeading(h) { gpsHeading = h; gpsHeadingAt = Date.now(); }
function currentHeading() {
  if (heading != null && Date.now() - compassAt < 3000) return heading;
  if (gpsHeading != null && Date.now() - gpsHeadingAt < 20000) return gpsHeading;
  return null;
}
function updateMeArrow() {
  const h = currentHeading();
  if (h != null) {
    // rotazione sempre per la via più breve (niente giro completo passando da 359° a 0°)
    if (shownDeg == null) shownDeg = h;
    else shownDeg += ((((h - shownDeg) % 360) + 540) % 360) - 180;
  }
  document.querySelectorAll('.me-pos').forEach((el) => {
    el.classList.toggle('h', h != null);
    if (h != null) el.querySelector('svg').style.transform = `rotate(${shownDeg}deg)`;
  });
}
function startCompass() {
  addEventListener('deviceorientationabsolute', onOrientation);
  addEventListener('deviceorientation', onOrientation);
}

function startCarTracking() {
  if (navigator.geolocation && carWatch == null) {
    let carGood = 0;
    carWatch = navigator.geolocation.watchPosition((p) => {
      // posizione dalla rete (imprecisa): la ignoro se negli ultimi 2 minuti ne ho avuta una buona dal GPS
      if (p.coords.accuracy > 60 && Date.now() - carGood < 120000) return;
      if (p.coords.accuracy <= 60) carGood = Date.now();
      carHere = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };
      state.gps = { ...carHere, alt: p.coords.altitude };
      drawMe(); drawCar(); updateCarArrow();
    }, () => { updateCarArrow(); }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
  }
}
function stopCarTracking() {
  if (carWatch != null) navigator.geolocation.clearWatch(carWatch);
  carWatch = null;
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
    $('#carSetGps').onclick = () => saveCarHere($('#carSetGps'));
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
  $('#carMove').onclick = () => { if (confirm('Spostare l’auto nella tua posizione attuale?')) saveCarHere($('#carMove')); };
  $('#carDel').onclick = async () => {
    if (!confirm('Rimuovere la posizione dell’auto?')) return;
    state.car = null; await kv.del('car'); drawCar(); renderCar();
  };
  updateCarArrow();
}

// salva l'auto solo con il GPS vero: aspetto fino a 30 s una precisione di 20 m (la prima stima del
// telefono può sbagliare di chilometri) e, se resta imprecisa, chiedo prima di salvarla
async function saveCarHere(btn) {
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Cerco il GPS…';
  try {
    const f = await preciseFix({ good: 20, timeout: 30000, onUpdate: (b) => { btn.textContent = `GPS ±${b.acc < 1000 ? Math.round(b.acc) + ' m' : fmt1(b.acc / 1000) + ' km'}…`; } });
    if (f.acc > 50 && !confirm(`Il GPS è ancora impreciso (±${f.acc < 1000 ? Math.round(f.acc) + ' m' : fmt1(f.acc / 1000) + ' km'}). Salvo comunque?\n\nMeglio: stai all'aperto qualche secondo e riprova, oppure sposta la mappa sull'auto e usa "Centro mappa".`)) return;
    await setCar(f);
  } catch (e) {
    toast(`${e.message}: usa “Centro mappa”`, 5000);
  } finally {
    if (btn.isConnected) { btn.disabled = false; btn.innerHTML = label; }
  }
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

// ---------------------------------------------------------------- guida a piedi
let nav = null, navMeta = null, navLayers = null, navRouteRef = null, followPausedUntil = 0, navZoomed = false, navHidSuit = false;
const navDist = (mm) => (mm == null ? '–' : mm >= 1000 ? `${fmt1(mm / 1000)} km` : `${Math.round(mm / 10) * 10} m`);
const navDur = (min) => (min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}'` : `${min}'`);

function renderVoiceSeg() {
  $$('#voiceSeg button').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.v === '1') === !!state.settings.navVoice)));
}

function walkToSpot(id) {
  const a = state.analysis;
  const s = a?.spots.find((x) => x.id === id) || a?.fungaie?.find((x) => x.id === id);
  if (!s) return;
  startNav([{ id: s.id, label: s.fungaia ? 'la tua fungaia' : `spot ${s.id}`, lat: s.lat, lon: s.lon }], null, { mode: 'spot', title: s.fungaia ? `Fungaia ${s.id}` : `Spot ${s.id}`, score: s.score });
}
function walkZone(zid) {
  const a = state.analysis;
  const z = a?.zones.find((x) => x.id === zid);
  if (!z) return;
  const pts = zonePts(z, a);
  const targets = pts.map((p) => ({ id: p.id, label: p.fungaia ? `la fungaia ${p.id}` : `spot ${p.id}`, lat: p.lat, lon: p.lon }));
  // ritorno: all'auto se è parcheggiata vicino, altrimenti allo spot vicino alla strada da cui parte il giro
  const back = state.car && distKm(state.car, targets[0]) <= 3 ? { id: 'auto', label: 'l\'auto', lat: state.car.lat, lon: state.car.lon } : { ...targets[0], id: 'ritorno', label: `il punto di partenza ${targets[0].id}` };
  startNav(targets, back, { mode: 'zona', title: `Giro zona ${z.id}`, zone: z.id });
}

async function startNav(targets, back, meta) {
  if (nav) { toast('C\'è già una guida in corso'); return; }
  navMeta = meta;
  if (!navLayers) navLayers = L.layerGroup().addTo(map);
  navLayers.clearLayers(); navRouteRef = null; navZoomed = false;
  targets.forEach((t, i) => L.circleMarker([t.lat, t.lon], { radius: 9, color: '#FFBF46', weight: 3, fillOpacity: 0.25 }).bindTooltip(`${i + 1}. ${t.label}`).addTo(navLayers));
  document.body.classList.add('nav-on');
  // da vicino lo strato dell'idoneità è una macchia sfocata sopra i sentieri: lo tolgo durante la guida
  navHidSuit = map.hasLayer(layers.suit); if (navHidSuit) map.removeLayer(layers.suit);
  $('#navBar').hidden = false;
  $('#navBar').innerHTML = `<div class="nav-main"><div class="nav-turn">${icon('walk')}</div><div><div class="nav-instr">Cerco la posizione…</div><div class="nav-sub">${esc(meta.title)} · calcolo il percorso sui sentieri</div></div></div>${navButtonsHtml()}`;
  bindNavButtons();
  if (innerWidth < 900) setSheet('peek');
  map.on('dragstart', pauseFollow);
  nav = createNav(targets, back, {
    voice: state.settings.navVoice,
    onUpdate: renderNav,
    onArrive: (t) => toast(`Arrivato a ${t.label}`),
    onFinish: finishNav,
    onError: (msg) => toast(msg, 5000),
  });
  try { await nav.start(); } catch (e) { toast(e.message || 'Posizione non disponibile', 5000); stopNavUi(); nav = null; }
}
const pauseFollow = () => { followPausedUntil = Date.now() + 15000; };

function navButtonsHtml() {
  const v = state.settings.navVoice;
  return `<div class="nav-btns">
    <button type="button" class="btn" id="navVoice" title="Voce o solo vibrazione">${icon(v ? 'volume' : 'vibrate')} ${v ? 'Voce' : 'Vibra'}</button>
    <button type="button" class="btn" id="navFind" title="Salva una fungaia qui">${icon('plus')} Fungaia</button>
    <button type="button" class="btn" id="navSkip" title="Salta questa tappa">${icon('skip')} Salta</button>
    <button type="button" class="btn stop" id="navStop" title="Termina">${icon('stop')} Fine</button>
  </div>`;
}
function bindNavButtons() {
  $('#navVoice').onclick = () => { saveSettings({ navVoice: !state.settings.navVoice }); renderVoiceSeg(); nav?.setVoice(state.settings.navVoice); const b = $('#navVoice'); const v = state.settings.navVoice; b.innerHTML = `${icon(v ? 'volume' : 'vibrate')} ${v ? 'Voce' : 'Vibra'}`; };
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
    if (v.pos.heading != null && (v.pos.speed ?? 0) > 0.7) setGpsHeading(v.pos.heading); // in cammino: direzione di marcia
    L.marker([v.pos.lat, v.pos.lon], { navMe: true, interactive: false, icon: L.divIcon({ className: '', html: ME_HTML, iconSize: [44, 44], iconAnchor: [22, 22] }) }).addTo(navLayers);
    updateMeArrow();
    // alla prima posizione la mappa si avvicina (zoom da sentiero), poi segue senza cambiare zoom
    if (!navZoomed) { navZoomed = true; map.setView([v.pos.lat, v.pos.lon], Math.max(map.getZoom(), 16)); }
    else if (Date.now() > followPausedUntil) map.panTo([v.pos.lat, v.pos.lon], { animate: true });
  }
  const showTurn = v.next && v.next.distM < 250; // freccia e scritta solo per una svolta vicina
  const turnIcon = v.off ? 'x' : showTurn && v.next.side === 'left' ? 'left' : showTurn && v.next.side === 'right' ? 'right' : 'up';
  const instr = !v.pos ? 'Cerco il segnale GPS…' : v.off ? 'Fuori percorso' : v.next?.beeline ? `${navDist(v.next.distM)} · ${v.next.text}` : v.next && v.next.distM < 250 ? `${navDist(v.next.distM)} · ${v.next.text}` : 'Prosegui sul sentiero';
  const flags = [v.offline && v.pos ? 'senza rete: guida in linea d\'aria' : '', v.weak ? 'GPS debole' : ''].filter(Boolean).join(' · ');
  const tgt = v.target ? `${v.returning ? 'Ritorno a' : 'Verso'} ${esc(v.target.label)}` : '';
  $('#navBar').innerHTML = `<div class="nav-main"><div class="nav-turn${v.off ? ' off' : ''}">${icon(turnIcon)}</div>
    <div class="grow"><div class="nav-instr">${instr}</div>
      <div class="nav-sub">${tgt} · <b>${navDist(v.distM)}</b>${v.etaMin != null ? ` · ~${navDur(v.etaMin)}` : ''}${v.n > 1 ? ` · tappa ${Math.min(v.k + 1, v.n)}/${v.n}` : ''}</div>${flags ? `<div class="nav-sub" style="color:var(--warn)">${flags}</div>` : ''}</div></div>${navButtonsHtml()}`;
  bindNavButtons();
}

function stopNavUi() {
  document.body.classList.remove('nav-on');
  if (navHidSuit) { layers.suit.addTo(map); navHidSuit = false; }
  $('#navBar').hidden = true;
  map.off('dragstart', pauseFollow);
}

async function finishNav(sum) {
  stopNavUi();
  const meta = navMeta || {};
  nav = null;
  navLayers?.clearLayers();
  await refreshFinds();
  const { found, other } = outingFinds(sum);
  const minutes = Math.max(1, Math.round((new Date(sum.endedAt) - new Date(sum.startedAt)) / 60000));
  const out = {
    id: sum.startedAt, ...meta, ...sum, minutes, found, other,
    outcome: found ? 'trovato' : other ? 'altri' : null,
  };
  const list = (await kv.get('outings')) || [];
  list.unshift(out);
  await kv.set('outings', list.slice(0, 200));
  markDirty();
  renderOutings();
  showOutingDialog(out);
}

// ritrovamenti salvati durante un giro: porcini e, a parte, altri funghi
function outingFinds(o) {
  const end = o.endedAt || new Date().toISOString();
  let found = 0, other = 0;
  for (const f of state.finds) for (const x of f.visits || []) {
    const t = x.createdAt || x.datetime || '';
    if (!(x.count > 0) || t < o.startedAt || t > end) continue;
    if (x.kind === 'altro') other++; else found++;
  }
  return { found, other };
}

// giri salvati prima della 1.29.1: "trovato" anche con soli altri funghi
async function fixOutingOutcomes() {
  const list = (await kv.get('outings')) || [];
  let ch = false;
  for (const o of list) {
    if (o.outcome !== 'trovato' || o.other != null) continue;
    const r = outingFinds(o);
    o.found = r.found; o.other = r.other;
    if (!r.found && r.other) o.outcome = 'altri';
    ch = true;
  }
  if (ch) { await kv.set('outings', list); markDirty(); }
}

function outingSummaryHtml(o) {
  return `<div class="out-sum">
    <div><b>${navDist(o.distanceM)}</b><span>percorsi</span></div>
    <div><b>${navDur(o.minutes)}</b><span>durata</span></div>
    <div><b>${o.visited.length}/${o.targets.length}</b><span>${o.targets.length > 1 ? 'tappe' : 'spot'}</span></div>
  </div>`;
}

function showOutingDialog(o) {
  const f = $('#outForm');
  const ask = !o.found && !o.other;
  f.innerHTML = `<h2>${esc(o.title || 'Giro')} ${o.reason === 'completato' ? 'completato' : 'terminato'}</h2>
    ${outingSummaryHtml(o)}
    ${!o.found && o.other ? `<p>Nessun porcino: hai salvato solo altri funghi (${o.other}).</p><button class="btn primary block" value="">Chiudi</button>`
    : ask ? `<p>Durante il giro non hai salvato nessuna fungaia. <b>È stato un giro a vuoto?</b></p>
      <div class="btn-row"><button class="btn primary" value="vuoto">Sì, a vuoto</button><button class="btn" value="trovato">No, ho trovato</button></div>
      <button class="btn block" style="margin-top:8px" value="">Decido dopo</button>`
    : `<p>Fungaie salvate durante il giro: <b>${o.found}</b>.</p><button class="btn primary block" value="">Chiudi</button>`}`;
  const dlg = $('#outDlg');
  dlg.onclose = async () => {
    const v = dlg.returnValue;
    if (!ask || !v) return;
    if (v === 'vuoto') await markOutingEmpty(o);
    else { await setOutingOutcome(o.id, 'trovato'); openFindForm('new'); }
  };
  dlg.showModal();
}

async function setOutingOutcome(id, outcome) {
  const list = (await kv.get('outings')) || [];
  const o = list.find((x) => x.id === id);
  if (o) { o.outcome = outcome; await kv.set('outings', list); markDirty(); }
  renderOutings();
}

// Giro a vuoto: un'uscita a vuoto nel centro delle tappe visitate (penalizza gli spot vicini come le altre)
async function markOutingEmpty(o) {
  const pts = o.targets.filter((t) => o.visited.includes(t.id));
  const use = pts.length ? pts : o.track.length ? [{ lat: o.track[o.track.length - 1][0], lon: o.track[o.track.length - 1][1] }] : o.targets;
  const lat = use.reduce((a, p) => a + p.lat, 0) / use.length, lon = use.reduce((a, p) => a + p.lon, 0) / use.length;
  const visit = { datetime: new Date().toISOString(), count: 0, notes: `${o.title || 'Giro'} a vuoto${pts.length ? ': ' + pts.map((p) => p.id).join(', ') : ''}` };
  const here = await placeNear(lat, lon);
  const today = visit.datetime.slice(0, 10);
  if (here && here.visits.some((v) => !(v.count > 0) && v.kind !== 'altro' && (v.datetime || '').slice(0, 10) === today)) { /* già registrata oggi */ }
  else if (here) await addVisit(here.id, visit);
  else await createPlace({ lat, lon, forestChoice: '' }, visit);
  await setOutingOutcome(o.id, 'vuoto');
  await refreshFinds();
  toast('Uscita a vuoto registrata: gli spot vicini saranno penalizzati per qualche settimana');
}

async function renderOutings() {
  const el = $('#outingList');
  if (!el) return;
  const list = (await kv.get('outings')) || [];
  setBadge('giri', list.length);
  if (!list.length) {
    el.innerHTML = `<div class="empty">${icon('walk')}<div>Qui trovi i riepiloghi dei giri fatti con la guida a piedi.<br>Avviane uno da una zona o da uno spot ("A piedi qui").</div></div>`;
    return;
  }
  const pill = (o) => (o.outcome === 'trovato' ? `<span class="pill ok">porcini${o.found ? ' ' + o.found : ''}</span>` : o.outcome === 'altri' ? '<span class="pill">solo altri funghi</span>' : o.outcome === 'vuoto' ? '<span class="pill warn">a vuoto</span>' : '<span class="pill">esito da indicare</span>');
  el.innerHTML = list.map((o, i) => `<div class="card click out-card" data-i="${i}">
      <div class="row"><div class="t grow">${esc(o.title || 'Giro')}</div>${pill(o)}</div>
      <div class="m">${new Date(o.startedAt).toLocaleString('it-IT', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${navDist(o.distanceM)} · ${navDur(o.minutes)} · ${o.visited.length}/${o.targets.length} ${o.targets.length > 1 ? 'tappe' : 'spot'}</div>
      <div class="nav-row" data-stop>
        ${!o.outcome ? '<button class="btn small" data-act="vuoto">Era a vuoto</button><button class="btn small" data-act="trovato">Ho trovato</button>' : ''}
        <button class="btn small" data-act="gpx">${icon('download')} GPX</button>
        <button class="btn small danger" data-act="del">Elimina</button>
      </div>
    </div>`).join('');
  $$('#outingList .out-card').forEach((c) => {
    const o = list[Number(c.dataset.i)];
    c.onclick = () => showOutingOnMap(o);
    c.querySelectorAll('[data-act]').forEach((b) => b.onclick = async (e) => {
      e.stopPropagation();
      const act = b.dataset.act;
      if (act === 'vuoto') await markOutingEmpty(o);
      else if (act === 'trovato') { await setOutingOutcome(o.id, 'trovato'); openFindForm('new'); }
      else if (act === 'gpx') await shareOrDownload(outingGpx(o), `giro-${o.startedAt.slice(0, 10)}.gpx`);
      else if (act === 'del' && confirm('Eliminare questo riepilogo?')) {
        const l = ((await kv.get('outings')) || []).filter((x) => x.id !== o.id);
        await kv.set('outings', l); markDirty(); renderOutings();
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
  const wpts = o.targets.map((t) => `<wpt lat="${t.lat}" lon="${t.lon}"><name>${x(t.label)}</name></wpt>`).join('\n');
  const trk = o.track.map((p) => `<trkpt lat="${p[0]}" lon="${p[1]}">${p[2] ? `<time>${new Date(p[2]).toISOString()}</time>` : ''}</trkpt>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Cerca Porcini" xmlns="http://www.topografix.com/GPX/1/1">\n${wpts}\n<trk><name>${x(o.title || 'Giro')}</name><trkseg>${trk}</trkseg></trk>\n</gpx>\n`;
}

// ---------------------------------------------------------------- aggiornamento dell'app Android
let updateAsked = false;
async function lookForUpdate(manual) {
  if (!navigator.onLine) { if (manual) toast('Serve la connessione per controllare'); return; }
  if (!manual && (updateAsked || nav)) return; // mai durante una guida a piedi
  let u = null;
  try { u = await checkUpdate(); } catch { u = null; }
  if (!u) { if (manual) toast(`Hai già l'ultima versione (${APP_VERSION})`); return; }
  updateAsked = true;
  $('#updForm').innerHTML = `<h2>Nuova versione disponibile</h2>
    <p>È pronta la versione <b>${esc(u.version)}</b> (tu hai la ${APP_VERSION})${u.sizeMb ? ` · ${u.sizeMb} MB` : ''}.</p>
    <p class="small muted">L'app la scarica e apre l'installazione: tocca <b>Aggiorna</b> nella schermata di Android. Fungaie e giri restano.</p>
    <div class="btn-row"><button class="btn primary" value="ok">Aggiorna ora</button><button class="btn" value="">Più tardi</button></div>`;
  const dlg = $('#updDlg');
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'ok') return;
    progress('Scarico l\'aggiornamento…', 0);
    try {
      await installUpdate((f) => progress(`Scarico l'aggiornamento… ${Math.round(f * 100)}%`, f));
      progress(null);
    } catch (e) {
      progress(null);
      toast(e.message || 'Aggiornamento non riuscito', 6000);
    }
  };
  dlg.showModal();
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
  const tabs = { analisi: ['target', 'Analisi'], spot: ['list', 'Spot'], fungaie: ['mushroom', 'Fungaie'], giri: ['walk', 'Giri'], impostazioni: ['settings', 'Opzioni'] };
  $$('.tab').forEach((t) => {
    const [ic, lb] = tabs[t.dataset.tab];
    t.innerHTML = `${icon(ic)}<span>${lb}${['spot', 'fungaie', 'giri'].includes(t.dataset.tab) ? '<span class="badge" hidden></span>' : ''}</span>`;
    t.onclick = () => switchTab(t.dataset.tab);
  });
  $('#sheetHandle').onclick = () => {
    const st = $('#panel').dataset.state;
    setSheet(st === 'peek' ? 'half' : st === 'half' ? 'full' : 'peek');
  };
  // un solo pulsante sulla mappa: apre "La mia posizione / La mia auto"
  const posMenu = (open) => { $('#posMenu').hidden = !open; $('#posBtn').setAttribute('aria-expanded', open); };
  $('#posBtn').innerHTML = icon('crosshair');
  $('#posBtn').onclick = (e) => { e.stopPropagation(); posMenu($('#posMenu').hidden); };
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.map-ctrls')) posMenu(false); });
  $('#carBtn').innerHTML = `${icon('car')} La mia auto`;
  $('#carBtn').onclick = () => { posMenu(false); openCar(); };
  $('#carClose').innerHTML = icon('x');
  $('#carClose').onclick = () => $('#carDlg').close();
  $('#carDlg').addEventListener('close', stopCarTracking);
  $('#locateBtn').innerHTML = `${icon('crosshair')} La mia posizione`;
  $('#locateBtn').onclick = () => { posMenu(false); state.start = null; locate({ center: true }); };
  $('#usePosBtn').innerHTML = icon('crosshair');
  $('#usePosBtn').onclick = () => { state.start = null; locate({ center: true }); };
  $('#fabFind').innerHTML = icon('plus');
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
  $('#forestPref').onchange = (e) => saveSettings({ forestPref: e.target.value });
  $$('#voiceSeg button').forEach((b) => b.onclick = () => { saveSettings({ navVoice: b.dataset.v === '1' }); renderVoiceSeg(); nav?.setVoice(state.settings.navVoice); });
  $('#windowDays').oninput = (e) => { $('#windowDaysVal').textContent = `${e.target.value} gg`; saveSettings({ windowDays: Number(e.target.value) }); };
  $('#gradient').oninput = (e) => { $('#gradientVal').textContent = Number(e.target.value).toFixed(2).replace('.', ','); saveSettings({ gradient: Number(e.target.value) }); };
  for (const k of ['rainMinMm', 'rainEventMm', 'southOffsetM', 'maxSpots', 'maxWalkMin']) {
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
  $('#fCamera').onchange = (e) => { const files = [...e.target.files]; newPhotos.push(...files); files.forEach((f) => photoToGallery(f)); e.target.value = ''; renderGallery(); };
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
  $('#importDriveBtn').onclick = importFromDrive;
  $('#importFile').onchange = async (e) => { try { await importBackup(e.target.files[0]); } catch (err) { toast('Import non riuscito: ' + err.message); } e.target.value = ''; };
  $('#clearTilesBtn').onclick = async () => { await caches.delete('cp-tiles-v2'); toast('Mappe offline eliminate'); updateStorageInfo(); };
  $('#versionInfo').textContent = `Versione ${APP_VERSION}${NATIVE ? ' · app Android' : ''}`;
  $('#updateBtn').hidden = !NATIVE;
  $('#updateBtn').onclick = () => lookForUpdate(true);

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
  initSearch();
  bindUI();
  renderControls();
  renderSyncStatus();
  if (innerWidth < 900) setSheet('peek'); // la mappa resta protagonista: il pannello si apre toccando una scheda

  const lastGps = await kv.get('lastGps');
  if (lastGps) { state.gps = lastGps; state.start = { lat: lastGps.lat, lon: lastGps.lon, manual: false }; map.setView([lastGps.lat, lastGps.lon], 10); }
  renderStart(); drawMe();
  state.car = (await kv.get('car')) || null;
  state.blocked = (await kv.get('blocked')) || [];
  renderBlocked();
  drawCar();

  state.analysis = await kv.get('lastAnalysis');
  if (state.analysis) { drawAnalysis(state.analysis, !lastGps); renderResults(); }
  renderSpots();
  await migrateFinds(); // fungaie della prima versione -> luogo + ritrovamenti
  await refreshFinds();
  renderOutings();
  startCompass();
  initSafety({ syncSilently, buildBackup, onChange: () => renderSyncStatus() });
  dirtySince().then((d) => {
    if (d && Date.now() - new Date(d) > 24 * 36e5) setTimeout(() => toast('Hai modifiche non salvate su Drive da più di un giorno: apri Fungaie e premi Sincronizza', 8000), 4000);
  });
  if (NATIVE) localBackup().catch(() => {}); // copia di sicurezza aggiornata a ogni apertura
  if (NATIVE) setTimeout(() => lookForUpdate(false), 2500); // controllo della nuova versione all'apertura
  locate({ silent: true });
  completePending();
  updateStorageInfo();

  if (!NATIVE && 'serviceWorker' in navigator && location.protocol !== 'file:') {
    // nuova versione installata: ricarico subito (se non sto calcolando) per non restare sulla vecchia
    const hadSW = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadSW) return;
      if ($('#progress').hidden) location.reload();
      else toast('Nuova versione pronta: riapri l’app quando hai finito', 6000);
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then((r) => r.update())
      .catch((e) => console.warn('SW', e));
  }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
}

init().catch((e) => { console.error(e); toast('Errore di avvio: ' + e.message, 6000); });
