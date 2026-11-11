// patch grafica 1: font, palette, pulsanti mappa, pannello ridotto su telefono
const fs = require('fs');
process.chdir(__dirname + '/..');
const rep = (f, a, b) => { let s = fs.readFileSync(f, 'utf8'); if (!s.includes(a)) throw new Error(f + ': ' + a.slice(0, 70)); fs.writeFileSync(f, s.replace(a, b)); };
const H = 'index.html';
rep(H, `  <meta name="theme-color" content="#2f6d3c">`, `  <meta name="theme-color" content="#E4FDE1">`);
rep(H, `  <link rel="stylesheet" href="vendor/leaflet/leaflet.css">`, `  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Darumadrop+One&family=Nunito:wght@400;600;700;800&display=swap">
  <link rel="stylesheet" href="vendor/leaflet/leaflet.css">`);
rep(H, `<body data-sheet="half">`, `<body data-sheet="peek">`);
rep(H, `  <div class="map-ctrls">
    <button class="icon-btn" id="carBtn" title="La mia auto" aria-label="La mia auto"></button>
    <button class="icon-btn" id="locateBtn" title="La mia posizione" aria-label="La mia posizione"></button>
  </div>
  <button class="fab" id="fabFind"></button>`, `  <div class="map-ctrls">
    <div class="pos-menu" id="posMenu" hidden>
      <button class="btn" id="locateBtn"></button>
      <button class="btn" id="carBtn"></button>
    </div>
    <button class="icon-btn" id="posBtn" title="Posizione e auto" aria-label="Posizione e auto" aria-expanded="false"></button>
  </div>
  <button class="fab" id="fabFind" title="Nuova fungaia" aria-label="Nuova fungaia"></button>`);
rep(H, `  <aside class="panel" id="panel" data-state="half">`, `  <aside class="panel" id="panel" data-state="peek">`);

// ---- CSS: palette e font
const C = 'css/app.css';
let css = fs.readFileSync(C, 'utf8');
const end = css.indexOf('* { box-sizing: border-box; }');
css = `/* Palette: Frosted Mint #E4FDE1 · Willow Green #8ACB88 · Deep Teal #648381 · Charcoal #575761 · Sunflower Gold #FFBF46
   Font: Darumadrop One (logo, titoli, voti) · Nunito (testi) */
:root {
  --mint: #E4FDE1; --willow: #8ACB88; --teal: #648381; --charcoal: #575761; --gold: #FFBF46;
  --bg: var(--mint);
  --surface: #ffffff;
  --surface-2: #f2fbf0;
  --text: #3d3d45;            /* Charcoal scurito: più leggibile al sole */
  --muted: #6b6b75;
  --border: #cfe6cb;
  --primary: var(--teal);
  --primary-2: #557371;
  --primary-text: #4a6664;    /* Deep Teal scurito per testi e link */
  --on-primary: #ffffff;
  --accent: var(--gold);
  --on-accent: #3d3d45;
  --warm: #e09a1f;
  --cool: var(--teal);
  --ok: #3f8f3c;
  --warn: #b7791f;
  --danger: #b42318;
  --shadow: 0 8px 24px rgba(61, 61, 69, .16), 0 2px 6px rgba(61, 61, 69, .08);
  --radius: 18px;
  --radius-sm: 12px;
  --panel-w: 420px;
  --appbar-h: 56px;
  --font: "Nunito", system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  --font-display: "Darumadrop One", "Nunito", system-ui, sans-serif;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #3a3a41; --surface: var(--charcoal); --surface-2: #4a4a53; --text: var(--mint); --muted: #c3cfc1;
    --border: #6a6a74; --primary: var(--willow); --primary-2: #77b875; --primary-text: var(--willow); --on-primary: #2f2f35;
    --ok: var(--willow); --warn: var(--gold); --danger: #ff8a7a; --shadow: 0 10px 30px rgba(0,0,0,.45); color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #3a3a41; --surface: var(--charcoal); --surface-2: #4a4a53; --text: var(--mint); --muted: #c3cfc1;
  --border: #6a6a74; --primary: var(--willow); --primary-2: #77b875; --primary-text: var(--willow); --on-primary: #2f2f35;
  --ok: var(--willow); --warn: var(--gold); --danger: #ff8a7a; --shadow: 0 10px 30px rgba(0,0,0,.45); color-scheme: dark;
}

` + css.slice(end);
css = css.replace(`  font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;`, `  font: 15px/1.45 var(--font);`);
css = css.replace(`.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 17px; letter-spacing: -.01em; }`, `.brand { display: flex; align-items: center; gap: 10px; font-family: var(--font-display); font-weight: 400; font-size: 22px; color: var(--primary-text); }`);
css = css.replace(`h2 { font-size: 18px; margin: 4px 0 12px; letter-spacing: -.01em; }
h3 { font-size: 14px; margin: 18px 0 8px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; font-weight: 700; }`, `h2 { font-family: var(--font-display); font-weight: 400; font-size: 22px; margin: 4px 0 12px; color: var(--primary-text); }
h3 { font-family: var(--font-display); font-weight: 400; font-size: 18px; margin: 20px 0 8px; color: var(--primary-text); }`);
css = css.replace(`a { color: var(--primary); }`, `a { color: var(--primary-text); }`);
css = css.replace(`.tab[aria-selected="true"] { background: var(--surface-2); color: var(--primary); }`, `.tab[aria-selected="true"] { background: var(--surface-2); color: var(--primary-text); }`);
// segnaposto: colore dal voto (impostato in linea), numeri in Darumadrop
css = css.replace(`  display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 12px;
  box-shadow: 0 3px 8px rgba(0,0,0,.35); border: 2px solid #fff;
}`, `  display: grid; place-items: center; color: #3d3d45; font-family: var(--font-display); font-size: 15px;
  box-shadow: 0 3px 8px rgba(0,0,0,.35); border: 2px solid #fff;
}`);
css = css.replace(`.spot-pin.fung { border: 3px solid #7a3e12; box-shadow: 0 0 0 2px #fff, 0 3px 8px rgba(0,0,0,.4); }
.card.spot.fung { border-left: 4px solid #7a3e12; }
.pill.zone { background: #1d4ed8; color: #fff; border-color: #1d4ed8; }
.find-pin { width: 30px; height: 30px; border-radius: 50%; background: #7a3e12;`, `.spot-pin.fung { background: var(--charcoal) !important; color: var(--gold) !important; border: 3px solid var(--gold); box-shadow: 0 0 0 2px #fff, 0 3px 8px rgba(0,0,0,.4); }
.card.spot.fung { border-left: 4px solid var(--gold); }
.pill.zone { background: var(--teal); color: #fff; border-color: var(--teal); }
.find-pin { width: 30px; height: 30px; border-radius: 50%; background: var(--charcoal);`);
css = css.replace(`.score { width: 46px; height: 46px; border-radius: 12px; display: grid; place-items: center; color: #fff; font-weight: 800; font-size: 16px; }`, `.score { width: 46px; height: 46px; border-radius: 14px; display: grid; place-items: center; color: #3d3d45; font-family: var(--font-display); font-size: 22px; }`);
css = css.replace(`.band .big { font-size: 22px; font-weight: 750; letter-spacing: -.02em; }`, `.band .big { font-family: var(--font-display); font-size: 26px; font-weight: 400; }`);
css = css.replace(`.kpi b { display: block; font-size: 20px; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }`, `.kpi b { display: block; font-family: var(--font-display); font-weight: 400; font-size: 22px; }`);
css = css.replace(`.rainbars i { flex: 1; background: #3b82f6;`, `.rainbars i { flex: 1; background: var(--teal);`);
// pulsante + Fungaia tondo e oro
css = css.replace(`.fab {
  position: fixed; z-index: 1050; bottom: 24px; border: 0; border-radius: 16px; padding: 14px 18px; cursor: pointer;
  background: var(--accent); color: #fff; font-weight: 700; display: flex; gap: 8px; align-items: center; box-shadow: var(--shadow);
}`, `.fab {
  position: fixed; z-index: 1050; bottom: 24px; border: 0; border-radius: 50%; width: 58px; height: 58px; cursor: pointer;
  background: var(--accent); color: var(--on-accent); display: grid; place-items: center; box-shadow: var(--shadow);
}
.fab svg.i { width: 28px; height: 28px; stroke-width: 2.6; }`);
css = css.replace(`.map-ctrls .icon-btn { background: var(--surface); box-shadow: var(--shadow); width: 44px; height: 44px; }`, `.map-ctrls { align-items: flex-end; }
.map-ctrls .icon-btn { background: var(--surface); box-shadow: var(--shadow); width: 46px; height: 46px; border-radius: 50%; }
.pos-menu { display: flex; flex-direction: column; gap: 6px; background: var(--surface); padding: 8px; border-radius: 14px; box-shadow: var(--shadow); }
.pos-menu .btn { justify-content: flex-start; padding: 10px 12px; font-size: 14px; white-space: nowrap; }
#posBtn.car { box-shadow: var(--shadow), 0 0 0 3px var(--gold); }`);
css = css.replace(`#carBtn.on { background: #2563eb; color: #fff; }`, `#carBtn.on { border-color: var(--gold); }`);
css = css.replace(`.car-pin { width: 34px; height: 34px; border-radius: 10px; background: #2563eb;`, `.car-pin { width: 34px; height: 34px; border-radius: 10px; background: var(--teal);`);
// telefono: pannello basso di partenza, niente zoom +/-
css = css.replace(`  .panel[data-state="peek"] { height: 112px; }`, `  .panel[data-state="peek"] { height: 96px; }`);
css = css.replace(`  body[data-sheet="peek"] .fab { bottom: 126px; }`, `  body[data-sheet="peek"] .fab { bottom: 110px; }`);
css = css.replace(`  body[data-sheet="peek"] .map-ctrls { bottom: 188px; }`, `  body[data-sheet="peek"] .map-ctrls { bottom: 180px; }
  .leaflet-control-zoom { display: none; }`);
fs.writeFileSync(C, css);

// ---- JS: pulsanti e colori
const P = 'js/app.js';
rep(P, `const scoreColor = (s) => (s >= 70 ? '#15803d' : s >= 50 ? '#65a30d' : s >= 35 ? '#ca8a04' : '#9a6b4f');`, `// colore del voto (palette): alto oro, medio verde salice, basso verde acqua (testo chiaro)
const scoreColor = (s) => (s >= 70 ? '#FFBF46' : s >= 40 ? '#8ACB88' : '#648381');
const scoreFg = (s) => (s >= 40 ? '#3d3d45' : '#ffffff');`);
rep(P, `  document.querySelector('meta[name="theme-color"]').content = dark ? '#161c19' : '#2f6d3c';`, `  document.querySelector('meta[name="theme-color"]').content = dark ? '#3a3a41' : '#E4FDE1';`);
rep(P, `html: \`<div class="spot-pin" style="background:\${scoreColor(s.score)}\${s.protected ? ';border-color:#dc2626' : ''}"><span>\${s.score}</span></div>\``, `html: \`<div class="spot-pin" style="background:\${scoreColor(s.score)};color:\${scoreFg(s.score)}\${s.protected ? ';border-color:#dc2626' : ''}"><span>\${s.score}</span></div>\``);
rep(P, `html: \`<div class="spot-pin fung" style="background:\${scoreColor(s.score)}"><span>\${s.score}</span></div>\``, `html: \`<div class="spot-pin fung"><span>\${s.score}</span></div>\``);
rep(P, `      <div class="score" style="background:\${scoreColor(s.score)}">\${s.score}</div>`, `      <div class="score" style="background:\${scoreColor(s.score)};color:\${scoreFg(s.score)}">\${s.score}</div>`);
rep(P, `  $('#carBtn').innerHTML = icon('car');
  $('#carBtn').onclick = openCar;`, `  // un solo pulsante sulla mappa: apre "La mia posizione / La mia auto"
  const posMenu = (open) => { $('#posMenu').hidden = !open; $('#posBtn').setAttribute('aria-expanded', open); };
  $('#posBtn').innerHTML = icon('crosshair');
  $('#posBtn').onclick = (e) => { e.stopPropagation(); posMenu($('#posMenu').hidden); };
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.map-ctrls')) posMenu(false); });
  $('#carBtn').innerHTML = \`\${icon('car')} La mia auto\`;
  $('#carBtn').onclick = () => { posMenu(false); openCar(); };`);
rep(P, `  $('#locateBtn').innerHTML = icon('crosshair');
  $('#locateBtn').onclick = () => { state.start = null; locate({ center: true }); };`, `  $('#locateBtn').innerHTML = \`\${icon('crosshair')} La mia posizione\`;
  $('#locateBtn').onclick = () => { posMenu(false); state.start = null; locate({ center: true }); };`);
rep(P, `  $('#fabFind').innerHTML = \`\${icon('plus')} Fungaia\`;`, `  $('#fabFind').innerHTML = icon('plus');`);
rep(P, `  $('#carBtn').classList.toggle('on', !!c);`, `  $('#carBtn').classList.toggle('on', !!c);
  $('#posBtn').classList.toggle('car', !!c);`);
console.log('ok grafica1');
