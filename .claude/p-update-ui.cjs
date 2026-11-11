// patch: avviso di nuova versione nell'app Android e aggiornamento con un tocco
const fs = require('fs');
process.chdir(__dirname + '/..');
const rep = (f, a, b) => { let s = fs.readFileSync(f, 'utf8'); if (!s.includes(a)) throw new Error(f + ': ' + a.slice(0, 80)); fs.writeFileSync(f, s.replace(a, () => b)); };

// dipendenze e permesso di installare aggiornamenti
rep('package.json', `    "@capacitor-community/background-geolocation": "^1.2.26",`, `    "@capacitor-community/background-geolocation": "^1.2.26",
    "@capacitor-community/file-opener": "^8.0.1",`);
rep('package.json', `    "@capacitor/core": "^8.5.3",`, `    "@capacitor/core": "^8.5.3",
    "@capacitor/filesystem": "^8.1.5",`);
rep('scripts/android-patch.mjs', `  'android.permission.WAKE_LOCK',`, `  'android.permission.WAKE_LOCK',
  'android.permission.REQUEST_INSTALL_PACKAGES', // per installare gli aggiornamenti scaricati dall'app`);

// HTML: pulsante in Opzioni e finestra di aggiornamento
rep('index.html', `      <p class="small muted" id="versionInfo"></p>`, `      <p class="small muted" id="versionInfo"></p>
      <button class="btn block" id="updateBtn" hidden>Controlla aggiornamenti</button>`);
rep('index.html', `  <dialog id="outDlg"><form method="dialog" id="outForm"></form></dialog>`, `  <dialog id="outDlg"><form method="dialog" id="outForm"></form></dialog>
  <dialog id="updDlg"><form method="dialog" id="updForm" style="padding:16px"></form></dialog>`);

// JS
const P = 'js/app.js';
rep(P, `import { createNav, walkMin } from './nav.js';`, `import { createNav, walkMin } from './nav.js';
import { checkUpdate, installUpdate } from './update.js';`);
rep(P, "  $('#versionInfo').textContent = `Versione ${APP_VERSION}`;", "  $('#versionInfo').textContent = `Versione ${APP_VERSION}${NATIVE ? ' · app Android' : ''}`;\n  $('#updateBtn').hidden = !NATIVE;\n  $('#updateBtn').onclick = () => lookForUpdate(true);");
rep(P, `  await refreshFinds();
  renderOutings();`, `  await refreshFinds();
  renderOutings();
  if (NATIVE) setTimeout(() => lookForUpdate(false), 2500); // controllo della nuova versione all'apertura`);
rep(P, `// ---------------------------------------------------------------- tab e pannello`, `// ---------------------------------------------------------------- aggiornamento dell'app Android
let updateAsked = false;
async function lookForUpdate(manual) {
  if (!navigator.onLine) { if (manual) toast('Serve la connessione per controllare'); return; }
  if (!manual && (updateAsked || nav)) return; // mai durante una guida a piedi
  let u = null;
  try { u = await checkUpdate(); } catch { u = null; }
  if (!u) { if (manual) toast(\`Hai già l'ultima versione (\${APP_VERSION})\`); return; }
  updateAsked = true;
  $('#updForm').innerHTML = \`<h2>Nuova versione disponibile</h2>
    <p>È pronta la versione <b>\${esc(u.version)}</b> (tu hai la \${APP_VERSION})\${u.sizeMb ? \` · \${u.sizeMb} MB\` : ''}.</p>
    <p class="small muted">L'app la scarica e apre l'installazione: tocca <b>Aggiorna</b> nella schermata di Android. Fungaie e giri restano.</p>
    <div class="btn-row"><button class="btn primary" value="ok">Aggiorna ora</button><button class="btn" value="">Più tardi</button></div>\`;
  const dlg = $('#updDlg');
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'ok') return;
    progress('Scarico l\\'aggiornamento…', 0);
    try {
      await installUpdate((f) => progress(\`Scarico l'aggiornamento… \${Math.round(f * 100)}%\`, f));
      progress(null);
    } catch (e) {
      progress(null);
      toast(e.message || 'Aggiornamento non riuscito', 6000);
    }
  };
  dlg.showModal();
}

// ---------------------------------------------------------------- tab e pannello`);
// service worker: aggiungo il nuovo file
rep('sw.js', `'js/platform.js', 'js/nav.js',`, `'js/platform.js', 'js/nav.js', 'js/update.js',`);
console.log('ok');
