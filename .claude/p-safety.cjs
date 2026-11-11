// patch: protezioni contro la perdita dei dati
const fs = require('fs');
process.chdir(__dirname + '/..');
const rep = (f, a, b) => { let s = fs.readFileSync(f, 'utf8'); if (!s.includes(a)) throw new Error(f + ': ' + a.slice(0, 80)); fs.writeFileSync(f, s.replace(a, () => b)); };

// plugin per la Galleria
rep('package.json', `    "@capacitor-community/file-opener": "^8.0.1",`, `    "@capacitor-community/file-opener": "^8.0.1",
    "@capacitor-community/media": "^9.1.0",`);

// drive.js: accesso ancora valido? (per la sincronizzazione automatica senza chiedere niente)
const D = 'js/drive.js';
rep(D, `export async function getToken(clientId, interactive = true) {`, `export const hasToken = () => !!token && Date.now() < tokenExp - 60000;

export async function getToken(clientId, interactive = true) {`);

// app.js
const P = 'js/app.js';
rep(P, `import { checkUpdate, installUpdate } from './update.js';`, `import { checkUpdate, installUpdate } from './update.js';
import { initSafety, markDirty, markSynced, dirtySince, localBackup, photoToGallery } from './safety.js';`);
let s = fs.readFileSync(P, 'utf8');
if (!/import \{[^}]*\bsyncDrive\b[^}]*\} from '\.\/drive\.js';/.test(s)) throw new Error('import drive');
s = s.replace(/import \{([^}]*\bsyncDrive\b[^}]*)\} from '\.\/drive\.js';/, (m, g) => `import {${g.replace(/\s*$/, '')}, hasToken } from './drive.js';`);
fs.writeFileSync(P, s);

// backup: un solo costruttore usato da "Esporta backup" e dalla copia automatica (ora include anche i giri)
rep(P, `async function exportBackup() {
  const fs = await fdb.all();
  const ps = await pdb.all();
  const toB64 = (b) => new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
  const photos = [];
  for (const p of ps) photos.push({ id: p.id, findId: p.findId, driveId: p.driveId, data: await toB64(p.blob) });
  const blob = new Blob([JSON.stringify({ app: 'cerca-porcini', version: APP_VERSION, exportedAt: new Date().toISOString(), finds: fs, photos })], { type: 'application/json' });
  download(blob, \`cerca-porcini-backup-\${todayStr()}.json\`);
}`, `async function buildBackup() {
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
  download(blob, \`cerca-porcini-backup-\${todayStr()}.json\`);
}`);
// import: anche i giri
rep(P, `  await refreshFinds();
  toast(\`Importate \${n} fungaie\`);`, `  if (Array.isArray(j.outings) && j.outings.length) {
    const cur = (await kv.get('outings')) || [];
    const ids = new Set(cur.map((o) => o.id));
    await kv.set('outings', [...cur, ...j.outings.filter((o) => !ids.has(o.id))].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || '')));
    renderOutings();
  }
  await refreshFinds();
  markDirty();
  toast(\`Importate \${n} fungaie\${j.outings?.length ? \` e \${j.outings.length} giri\` : ''}\`);`);
// modifiche -> markDirty
rep(P, `  await refreshFinds();
  completePending();
  if (mode !== 'new') setTimeout(() => openView(saved.id), 50);`, `  await refreshFinds();
  markDirty();
  completePending();
  if (mode !== 'new') setTimeout(() => openView(saved.id), 50);`);
rep(P, `    await deleteFind(id); $('#viewDlg').close(); await refreshFinds(); toast('Fungaia eliminata');`, `    await deleteFind(id); $('#viewDlg').close(); await refreshFinds(); markDirty(); toast('Fungaia eliminata');`);
rep(P, `  await kv.set('outings', list.slice(0, 200));`, `  await kv.set('outings', list.slice(0, 200));
  markDirty();`);
rep(P, `  if (o) { o.outcome = outcome; await kv.set('outings', list); }`, `  if (o) { o.outcome = outcome; await kv.set('outings', list); markDirty(); }`);
rep(P, `        await kv.set('outings', l); renderOutings();`, `        await kv.set('outings', l); markDirty(); renderOutings();`);
// foto scattate dall'app -> Galleria
rep(P, `  $('#fCamera').onchange = (e) => { newPhotos.push(...e.target.files); e.target.value = ''; renderGallery(); };`, `  $('#fCamera').onchange = (e) => { const files = [...e.target.files]; newPhotos.push(...files); files.forEach((f) => photoToGallery(f)); e.target.value = ''; renderGallery(); };`);
// sincronizzazione riuscita -> niente più modifiche in sospeso
rep(P, `    const r = await syncDrive(state.settings, saveSettings, (t) => progress(t, 0.5));
    await refreshFinds();
    renderSyncStatus();`, `    const r = await syncDrive(state.settings, saveSettings, (t) => progress(t, 0.5));
    await markSynced();
    await refreshFinds();
    renderSyncStatus();`);
// stato di sicurezza nella scheda Fungaie
rep(P, `function renderSyncStatus() {
  const s = state.settings;
  $('#syncStatus').innerHTML = !s.driveClientId
    ? 'Google Drive non configurato (Impostazioni).'
    : s.lastSync ? \`Ultima sincronizzazione con Drive: \${new Date(s.lastSync).toLocaleString('it-IT')}\` : 'Drive configurato: premi Sincronizza.';
}`, `async function renderSyncStatus() {
  const s = state.settings;
  const dirty = await dirtySince();
  const local = await kv.get('localBackupAt');
  const ago = dirty ? Math.round((Date.now() - new Date(dirty)) / 36e5) : 0;
  const line = !s.driveClientId
    ? 'Google Drive non configurato (Impostazioni).'
    : s.lastSync ? \`Ultima sincronizzazione con Drive: \${new Date(s.lastSync).toLocaleString('it-IT')}\` : 'Drive configurato: premi Sincronizza.';
  $('#syncStatus').innerHTML = (dirty
    ? \`<div class="alert \${ago >= 24 ? 'bad' : 'warn'}" style="margin:0 0 6px"><b>Modifiche non ancora salvate su Drive</b> \${ago >= 1 ? \`da \${ago} or\${ago === 1 ? 'a' : 'e'}\` : 'da poco'}: premi <b>Sincronizza</b> per metterle al sicuro.</div>\` : '')
    + line + (NATIVE && local ? \`<br>Copia di sicurezza sul telefono (Documenti/CercaPorcini): \${new Date(local).toLocaleString('it-IT')}\` : '');
}

// sincronizzazione automatica: solo se l'accesso a Google è ancora valido (dura circa un'ora dopo "Sincronizza")
async function syncSilently() {
  if (!state.settings.driveClientId || !hasToken() || !navigator.onLine) return;
  await syncDrive(state.settings, saveSettings, () => {});
  await markSynced();
  await refreshFinds(); renderOutings(); renderSyncStatus();
}`);
// avvio: collegamenti e promemoria
rep(P, `  await refreshFinds();
  renderOutings();`, `  await refreshFinds();
  renderOutings();
  initSafety({ syncSilently, buildBackup, onChange: () => renderSyncStatus() });
  dirtySince().then((d) => {
    if (d && Date.now() - new Date(d) > 24 * 36e5) setTimeout(() => toast('Hai modifiche non salvate su Drive da più di un giorno: apri Fungaie e premi Sincronizza', 8000), 4000);
  });
  if (NATIVE) localBackup().catch(() => {}); // copia di sicurezza aggiornata a ogni apertura`);
rep('sw.js', `'js/update.js', 'oauth.html',`, `'js/update.js', 'js/safety.js', 'oauth.html',`);
console.log('ok');
