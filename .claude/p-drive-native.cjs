// patch: Google Drive anche nell'app Android (accesso nel browser di sistema) + giri sincronizzati
const fs = require('fs');
process.chdir(__dirname + '/..');
const rep = (f, a, b) => { let s = fs.readFileSync(f, 'utf8'); if (!s.includes(a)) throw new Error(f + ': ' + a.slice(0, 80)); fs.writeFileSync(f, s.replace(a, () => b)); };

// plugin
rep('package.json', `    "@capacitor/android": "^8.5.3",`, `    "@capacitor/android": "^8.5.3",
    "@capacitor/app": "^8.1.2",
    "@capacitor/browser": "^8.0.5",`);
// indirizzo speciale dell'app per il ritorno dall'accesso Google
rep('scripts/android-patch.mjs', `fs.writeFileSync(mf, xml);`, `// ritorno dall'accesso Google (pagina oauth.html del sito -> it.cercaporcini.app://oauth)
if (!xml.includes('it.cercaporcini.app')) {
  xml = xml.replace(/(<\\/intent-filter>)/, \`$1
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="it.cercaporcini.app" android:host="oauth" />
            </intent-filter>\`);
}
if (!xml.includes('android:scheme="it.cercaporcini.app"')) throw new Error('AndroidManifest: ritorno OAuth non inserito');
fs.writeFileSync(mf, xml);`);

// drive.js: accesso nell'app con il browser di sistema
const D = 'js/drive.js';
rep(D, `import { normalizeFind } from './finds.js';`, `import { normalizeFind } from './finds.js';
import { NATIVE, plugin } from './platform.js';

// App Android: Google non permette l'accesso dentro l'app (WebView), quindi apro la pagina di Google nel
// browser di sistema; dopo l'accesso Google rimanda a oauth.html del sito, che ripassa il permesso all'app.
// Nella console Google Cloud questo indirizzo va aggiunto tra gli "URI di reindirizzamento autorizzati".
export const OAUTH_REDIRECT = 'https://fabiomru-pixel.github.io/cerca-porcini/oauth.html';
async function nativeToken(clientId) {
  const Browser = plugin('Browser'), App = plugin('App');
  if (!Browser || !App) throw new Error('Accesso a Google non disponibile in questa versione: aggiorna l\\'app');
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const q = { client_id: clientId, redirect_uri: OAUTH_REDIRECT, response_type: 'token', scope: SCOPE, state, include_granted_scopes: 'true' };
  if (!localStorage.getItem('cp-drive-consent')) q.prompt = 'consent';
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams(q);
  return new Promise((resolve, reject) => {
    let done = false, subUrl = null, subClose = null;
    const end = () => { done = true; subUrl?.remove?.(); subClose?.remove?.(); };
    App.addListener('appUrlOpen', async (ev) => {
      if (done || !ev.url || !ev.url.startsWith('it.cercaporcini.app://oauth')) return;
      end();
      try { await Browser.close(); } catch { /* già chiuso */ }
      const p = new URLSearchParams(ev.url.split('#')[1] || '');
      if (p.get('error')) return reject(new Error(p.get('error') === 'access_denied' ? 'Accesso Google annullato' : 'Accesso Google: ' + p.get('error')));
      if (p.get('state') !== state || !p.get('access_token')) return reject(new Error('Risposta di Google non valida, riprova'));
      token = p.get('access_token'); tokenExp = Date.now() + Number(p.get('expires_in') || 3600) * 1000;
      localStorage.setItem('cp-drive-consent', '1');
      resolve(token);
    }).then((h) => { subUrl = h; });
    Browser.addListener('browserFinished', () => {
      // chiuso a mano senza completare l'accesso
      setTimeout(() => { if (!done) { end(); reject(new Error('Accesso Google annullato')); } }, 2000);
    }).then((h) => { subClose = h; });
    Browser.open({ url }).catch((e) => { end(); reject(e); });
  });
}`);
rep(D, `  if (token && Date.now() < tokenExp - 60000) return token;
  await loadGis();`, `  if (token && Date.now() < tokenExp - 60000) return token;
  if (NATIVE) return nativeToken(clientId);
  await loadGis();`);
// giri: unione per id con quelli su Drive
rep(D, `  onStep('Salvo l’archivio su Drive…');`, `  // giri fatti con la guida a piedi: unione per id (vince quello con l'esito indicato o il più recente)
  onStep('Sincronizzo i giri…');
  let outings = 0;
  try {
    const gf = await findFile('giri.json', root);
    const remoteO = gf ? ((await (await api(\`/files/\${gf.id}?alt=media\`)).json()).outings || []) : [];
    const localO = (await kv.get('outings')) || [];
    const byId = new Map(localO.map((o) => [o.id, o]));
    for (const r of remoteO) {
      const l = byId.get(r.id);
      if (!l || (!l.outcome && r.outcome)) byId.set(r.id, r);
    }
    const merged = [...byId.values()].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || '')).slice(0, 300);
    await kv.set('outings', merged);
    outings = merged.length;
    const ob = new Blob([JSON.stringify({ app: 'cerca-porcini', savedAt: new Date().toISOString(), outings: merged })], { type: 'application/json' });
    await uploadFile({ id: gf?.id, name: 'giri.json', parent: root, blob: ob });
  } catch (e) { console.warn('giri su Drive', e); }

  onStep('Salvo l’archivio su Drive…');`);
rep(D, `  return { downloaded, uploaded, analyses, total: all.filter((f) => !f.deleted).length };`, `  return { downloaded, uploaded, analyses, outings, total: all.filter((f) => !f.deleted).length };`);

// app.js: niente più blocco nell'app, e dopo la sincronizzazione aggiorno la scheda Giri
const P = 'js/app.js';
rep(P, `  if (NATIVE) { toast('Nell\\'app la sincronizzazione con Drive non è ancora disponibile: usa Esporta/Importa backup in Opzioni', 6000); return; }
`, ``);
let a = fs.readFileSync(P, 'utf8');
a = a.replace("`<span class=\"pill ok\">GPS ±${Math.round(state.gps?.acc || 0)} m</span>`", () => "`<span class=\"pill ${(state.gps?.acc || 0) > 100 ? 'warn' : 'ok'}\">GPS ±${Math.round(state.gps?.acc || 0)} m</span>`");
fs.writeFileSync(P, a);
rep('sw.js', `'js/platform.js', 'js/nav.js', 'js/update.js',`, `'js/platform.js', 'js/nav.js', 'js/update.js', 'oauth.html',`);
console.log('ok');
