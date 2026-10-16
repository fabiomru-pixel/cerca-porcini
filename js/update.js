// Aggiornamento dell'app Android (installata fuori dal Play Store): all'apertura controllo la release
// "android-latest" su GitHub; se la versione è più nuova scarico il file e apro l'installazione di Android.
// L'ultimo tocco su "Aggiorna" è di Android e non si può saltare (regola di sicurezza per le app fuori dallo Store).
import { APP_VERSION } from './config.js';
import { NATIVE, plugin } from './platform.js';

const RELEASE_API = 'https://api.github.com/repos/fabiomru-pixel/cerca-porcini/releases/tags/android-latest';
const APK_URL = 'https://github.com/fabiomru-pixel/cerca-porcini/releases/download/android-latest/CercaPorcini.apk';

// true se a è una versione più nuova di b ("1.22.1" > "1.22.0")
export function isNewer(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

export async function checkUpdate() {
  if (!NATIVE) return null;
  const r = await fetch(RELEASE_API, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
  if (!r.ok) return null;
  const j = await r.json();
  const version = ((j.name || '').match(/(\d+\.\d+\.\d+)/) || [])[1];
  if (!version || !isNewer(version, APP_VERSION)) return null;
  const apk = (j.assets || []).find((a) => a.name.endsWith('.apk'));
  return { version, sizeMb: apk ? Math.round(apk.size / 1e6) : null };
}

// scarica il file nella cache dell'app e apre l'installazione; onProgress(0..1)
export async function installUpdate(onProgress) {
  const fs = plugin('Filesystem'), opener = plugin('FileOpener');
  if (!fs || !opener) throw new Error('Aggiornamento automatico non disponibile in questa versione: scaricala dal link della release');
  const path = 'CercaPorcini-aggiornamento.apk';
  let sub = null;
  if (onProgress) sub = await fs.addListener('progress', (p) => { if (p.contentLength) onProgress(p.bytes / p.contentLength); });
  try {
    const res = await fs.downloadFile({ url: APK_URL, path, directory: 'CACHE', progress: !!onProgress });
    const uri = res.path || (await fs.getUri({ path, directory: 'CACHE' })).uri;
    await opener.open({ filePath: uri, contentType: 'application/vnd.android.package-archive', openWithDefault: true });
  } finally {
    sub?.remove?.();
  }
}
