// patch: la posizione sulla mappa diventa una freccia orientata (bussola, o direzione di marcia del GPS)
const fs = require('fs');
process.chdir(__dirname + '/..');
const rep = (f, a, b, all = false) => {
  let s = fs.readFileSync(f, 'utf8');
  if (!s.includes(a)) throw new Error(f + ': ' + a.slice(0, 80));
  s = all ? s.split(a).join(b) : s.replace(a, () => b);
  fs.writeFileSync(f, s);
};
const P = 'js/app.js';

// marker: freccia + cerchio di riserva (senza direzione nota)
const OLD_ICON = `L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] })`;
rep(P, OLD_ICON, `L.divIcon({ className: '', html: ME_HTML, iconSize: [44, 44], iconAnchor: [22, 22] })`, true);
rep(P, `    L.marker([v.pos.lat, v.pos.lon], { navMe: true, interactive: false, icon: L.divIcon({ className: '', html: ME_HTML, iconSize: [44, 44], iconAnchor: [22, 22] }) }).addTo(navLayers);`,
  `    if (v.pos.heading != null && (v.pos.speed ?? 0) > 0.7) setGpsHeading(v.pos.heading); // in cammino: direzione di marcia
    L.marker([v.pos.lat, v.pos.lon], { navMe: true, interactive: false, icon: L.divIcon({ className: '', html: ME_HTML, iconSize: [44, 44], iconAnchor: [22, 22] }) }).addTo(navLayers);
    updateMeArrow();`);
rep(P, `    L.marker([state.gps.lat, state.gps.lon], { icon: L.divIcon({ className: '', html: ME_HTML, iconSize: [44, 44], iconAnchor: [22, 22] }), interactive: false }).addTo(layers.me);`,
  `    L.marker([state.gps.lat, state.gps.lon], { icon: L.divIcon({ className: '', html: ME_HTML, iconSize: [44, 44], iconAnchor: [22, 22] }), interactive: false }).addTo(layers.me);
    updateMeArrow();`);

// bussola sempre attiva: aggiorna anche la freccia della posizione
rep(P, `function onOrientation(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;          // iPhone
  else if (e.absolute && typeof e.alpha === 'number') h = (360 - e.alpha) % 360;        // Android
  if (h == null) return;
  // compensa la rotazione dello schermo
  const so = (screen.orientation && screen.orientation.angle) || 0;
  heading = (h + so) % 360;
  updateCarArrow();
}`, `function onOrientation(e) {
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
    if (h != null) el.querySelector('svg').style.transform = \`rotate(\${shownDeg}deg)\`;
  });
}
function startCompass() {
  addEventListener('deviceorientationabsolute', onOrientation);
  addEventListener('deviceorientation', onOrientation);
}`);
// la bussola non si spegne più chiudendo la finestra dell'auto
rep(P, `  addEventListener('deviceorientationabsolute', onOrientation);
  addEventListener('deviceorientation', onOrientation);
}
function stopCarTracking() {
  if (carWatch != null) navigator.geolocation.clearWatch(carWatch);
  carWatch = null; heading = null;
  removeEventListener('deviceorientationabsolute', onOrientation);
  removeEventListener('deviceorientation', onOrientation);
}`, `}
function stopCarTracking() {
  if (carWatch != null) navigator.geolocation.clearWatch(carWatch);
  carWatch = null;
}`);
rep(P, `  await refreshFinds();
  renderOutings();`, `  await refreshFinds();
  renderOutings();
  startCompass();`);

// CSS
fs.appendFileSync('css/app.css', `
/* ---------- Posizione: freccia orientata ---------- */
.me-pos { position: relative; width: 44px; height: 44px; }
.me-pos svg { position: absolute; inset: 0; width: 44px; height: 44px; display: none; transition: transform .25s linear;
  filter: drop-shadow(0 2px 3px rgba(0,0,0,.4)); }
.me-pos svg path { fill: #2563eb; stroke: #fff; stroke-width: 3; stroke-linejoin: round; }
.me-pos .dot { position: absolute; left: 13px; top: 13px; width: 18px; height: 18px; border-radius: 50%; background: #2563eb;
  border: 3px solid #fff; box-shadow: 0 0 0 6px rgba(37,99,235,.25); box-sizing: border-box; }
.me-pos.h svg { display: block; }
.me-pos.h .dot { display: none; }
`);
console.log('ok');
