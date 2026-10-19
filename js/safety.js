// Protezioni contro la perdita dei dati (dopo un "Cancella dati" che ha fatto perdere un weekend di fungaie):
// 1. sincronizzazione automatica su Drive dopo ogni modifica, se l'accesso a Google è ancora valido;
// 2. promemoria se ci sono modifiche non salvate su Drive da più di un giorno;
// 3. nell'app Android, copia di sicurezza automatica in Documenti/CercaPorcini (resta anche se si
//    cancellano i dati dell'app o la si disinstalla; si reimporta con "Importa backup");
// 4. nell'app Android, ogni foto scattata viene salvata anche in Galleria (album "Cerca Porcini").
import { kv } from './db.js';
import { NATIVE, plugin } from './platform.js';

const BACKUP_DIR = 'CercaPorcini';
const BACKUP_FILE = `${BACKUP_DIR}/cerca-porcini-backup-automatico.json`;
let hooks = { syncSilently: null, buildBackup: null, onChange: null };
let timer = null;

export function initSafety(h) { hooks = { ...hooks, ...h }; }

// da chiamare dopo ogni modifica di fungaie, uscite a vuoto o giri
export async function markDirty() {
  if (!(await kv.get('dirtySince'))) await kv.set('dirtySince', new Date().toISOString());
  hooks.onChange?.();
  clearTimeout(timer);
  timer = setTimeout(runSafety, 8000); // aspetto qualche secondo: più modifiche di fila = un solo salvataggio
}

export async function markSynced() {
  await kv.set('dirtySince', null);
  hooks.onChange?.();
}

export async function dirtySince() { return (await kv.get('dirtySince')) || null; }

async function runSafety() {
  try { await localBackup(); } catch (e) { console.warn('copia di sicurezza', e); }
  if (navigator.onLine) { try { await hooks.syncSilently?.(); } catch (e) { console.warn('sincronizzazione automatica', e); } }
}

// copia completa (fungaie, foto, giri) nella cartella Documenti/CercaPorcini del telefono
export async function localBackup() {
  const fs = plugin('Filesystem');
  if (!NATIVE || !fs || !hooks.buildBackup) return null;
  const data = JSON.stringify(await hooks.buildBackup());
  await fs.writeFile({ path: BACKUP_FILE, data, directory: 'DOCUMENTS', encoding: 'utf8', recursive: true });
  const at = new Date().toISOString();
  await kv.set('localBackupAt', at);
  hooks.onChange?.();
  return at;
}

// foto scattata dall'app -> anche in Galleria (album "Cerca Porcini")
export async function photoToGallery(file) {
  const media = plugin('Media');
  if (!NATIVE || !media || !file) return;
  try {
    const dataUrl = await new Promise((r, j) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.onerror = j; fr.readAsDataURL(file); });
    let { albums } = await media.getAlbums();
    let album = (albums || []).find((a) => a.name === 'Cerca Porcini');
    if (!album) {
      await media.createAlbum({ name: 'Cerca Porcini' });
      ({ albums } = await media.getAlbums());
      album = (albums || []).find((a) => a.name === 'Cerca Porcini');
    }
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    await media.savePhoto({ path: dataUrl, albumIdentifier: album?.identifier, fileName: `porcini-${stamp}` });
  } catch (e) { console.warn('foto in Galleria', e); }
}
