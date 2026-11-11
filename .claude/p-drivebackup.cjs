// patch: backup passato da un dispositivo all'altro tramite Drive (cartella "Cerca Porcini/backup")
const fs = require('fs');
process.chdir(__dirname + '/..');
const rep = (f, a, b) => { let s = fs.readFileSync(f, 'utf8'); if (!s.includes(a)) throw new Error(f + ': ' + a.slice(0, 80)); fs.writeFileSync(f, s.replace(a, () => b)); };

rep('js/drive.js', `// Sincronizzazione bidirezionale: vince la versione modificata più di recente`, `// Backup su Drive (cartella "Cerca Porcini/backup"): si salva da un dispositivo e si riprende dall'altro
// senza cercare il file nella memoria del telefono. Con il permesso drive.file l'app vede solo i backup
// salvati da Cerca Porcini (sito o app), non file copiati a mano su Drive.
async function backupFolder(settings, saveSettings) {
  await getToken(settings.driveClientId);
  const root = settings.driveFolderId || await ensureFolder(FOLDER_NAME);
  if (root !== settings.driveFolderId) await saveSettings({ driveFolderId: root });
  return ensureFolder('backup', root);
}
export async function uploadBackup(settings, saveSettings, blob, name) {
  const dir = await backupFolder(settings, saveSettings);
  return uploadFile({ name, parent: dir, blob });
}
export async function listBackups(settings, saveSettings) {
  const dir = await backupFolder(settings, saveSettings);
  const q = \`'\${dir}' in parents and trashed=false\`;
  const r = await (await api(\`/files?\${new URLSearchParams({ q, orderBy: 'modifiedTime desc', pageSize: '30', fields: 'files(id,name,modifiedTime,size)', spaces: 'drive' })}\`)).json();
  return r.files || [];
}
export async function downloadBackup(id) {
  return (await api(\`/files/\${id}?alt=media\`)).blob();
}

// Sincronizzazione bidirezionale: vince la versione modificata più di recente`);

const P = 'js/app.js';
let s = fs.readFileSync(P, 'utf8');
s = s.replace(/import \{([^}]*\bhasToken\b[^}]*)\} from '\.\/drive\.js';/, (m, g) => `import {${g.replace(/\s*$/, '')}, uploadBackup, listBackups, downloadBackup } from './drive.js';`);
if (!s.includes('uploadBackup, listBackups')) throw new Error('import drive');
fs.writeFileSync(P, s);

rep(P, `async function exportBackup() {
  const blob = new Blob([JSON.stringify(await buildBackup())], { type: 'application/json' });
  download(blob, \`cerca-porcini-backup-\${todayStr()}.json\`);
}`, `async function exportBackup() {
  const blob = new Blob([JSON.stringify(await buildBackup())], { type: 'application/json' });
  const name = \`cerca-porcini-backup-\${todayStr()}.json\`;
  if (!NATIVE) download(blob, name);
  // copia anche su Drive, così dall'altro dispositivo basta "Importa da Drive"
  if (!state.settings.driveClientId) { if (NATIVE) toast('Configura Google Drive per salvare il backup'); return; }
  try {
    progress('Salvo il backup su Drive…', 0.5);
    const t = new Date(); const pad = (n) => String(n).padStart(2, '0');
    await uploadBackup(state.settings, saveSettings, blob, \`cerca-porcini-backup-\${todayStr()}-ore\${pad(t.getHours())}\${pad(t.getMinutes())}-\${NATIVE ? 'telefono' : 'sito'}.json\`);
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
  f.innerHTML = \`<h2>Importa da Drive</h2>
    \${list.length ? \`<p class="small muted">Backup salvati con “Esporta backup” (il più recente in alto):</p>
      \${list.map((b) => \`<button class="btn block" style="margin-bottom:6px;text-align:left" value="\${esc(b.id)}"><b>\${new Date(b.modifiedTime).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })}</b> · \${esc(/telefono/.test(b.name) ? 'dal telefono' : /sito/.test(b.name) ? 'dal sito' : b.name)} · \${(Number(b.size || 0) / 1048576).toFixed(1)} MB</button>\`).join('')}\`
    : \`<p>Su Drive non c'è ancora nessun backup. Apri Cerca Porcini sull'altro dispositivo e premi <b>Esporta backup</b>: verrà salvato anche su Drive.</p>\`}
    <button class="btn block" value="">Annulla</button>\`;
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
}`);

rep(P, `  $('#importBtn').onclick = () => $('#importFile').click();`, `  $('#importBtn').onclick = () => $('#importFile').click();
  $('#importDriveBtn').onclick = importFromDrive;`);

rep('index.html', `        <button class="btn" id="importBtn">Importa backup</button>
      </div>`, `        <button class="btn" id="importBtn">Importa da file</button>
      </div>
      <button class="btn primary block" id="importDriveBtn" style="margin-top:8px">Importa da Drive</button>
      <p class="small muted">“Esporta backup” salva il backup anche su Drive: sull’altro dispositivo premi “Importa da Drive” e scegli il più recente.</p>`);
console.log('ok');
