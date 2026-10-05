// Sincronizzazione con Google Drive (cartella "Cerca Porcini", permesso drive.file:
// l'app vede solo i file che crea lei, non il resto del tuo Drive)
import { finds as fdb, photos as pdb, kv } from './db.js';
import { normalizeFind } from './finds.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_NAME = 'Cerca Porcini';
let token = null, tokenExp = 0, tokenClient = null;

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = res; s.onerror = () => rej(new Error('Impossibile caricare Google Sign-In (sei offline?)'));
    document.head.appendChild(s);
  });
}

export async function getToken(clientId, interactive = true) {
  if (!clientId) throw new Error('Manca il Client ID di Google: impostalo in Impostazioni.');
  if (token && Date.now() < tokenExp - 60000) return token;
  await loadGis();
  return new Promise((resolve, reject) => {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (r) => {
        if (r.error) return reject(new Error(r.error_description || r.error));
        token = r.access_token; tokenExp = Date.now() + r.expires_in * 1000;
        localStorage.setItem('cp-drive-consent', '1');
        resolve(token);
      },
      error_callback: (e) => reject(new Error(e.message || e.type || 'Accesso Google annullato')),
    });
    tokenClient.requestAccessToken({ prompt: interactive && !localStorage.getItem('cp-drive-consent') ? 'consent' : '' });
  });
}

async function api(path, opts = {}) {
  const res = await fetch(path.startsWith('http') ? path : API + path, {
    ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`Drive ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

async function findFile(name, parent, mime) {
  const q = [`name='${name.replace(/'/g, "\\'")}'`, 'trashed=false', parent ? `'${parent}' in parents` : null, mime ? `mimeType='${mime}'` : null].filter(Boolean).join(' and ');
  const r = await (await api(`/files?${new URLSearchParams({ q, fields: 'files(id,name,modifiedTime)', spaces: 'drive' })}`)).json();
  return r.files[0] || null;
}

async function ensureFolder(name, parent) {
  const mime = 'application/vnd.google-apps.folder';
  const f = await findFile(name, parent, mime);
  if (f) return f.id;
  const r = await (await api('/files', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: mime, parents: parent ? [parent] : undefined }),
  })).json();
  return r.id;
}

async function uploadFile({ id, name, parent, blob, mime }) {
  const meta = id ? {} : { name, parents: [parent] };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  form.append('file', blob, name);
  const url = id ? `${UPLOAD}/files/${id}?uploadType=multipart` : `${UPLOAD}/files?uploadType=multipart`;
  const r = await (await api(url, { method: id ? 'PATCH' : 'POST', body: form })).json();
  return r.id;
}

// Sincronizzazione bidirezionale: vince la versione modificata più di recente
export async function syncDrive(settings, saveSettings, onStep = () => {}) {
  await getToken(settings.driveClientId);
  onStep('Cartella su Drive…');
  const root = settings.driveFolderId || await ensureFolder(FOLDER_NAME);
  const photoDir = await ensureFolder('foto', root);
  if (root !== settings.driveFolderId) await saveSettings({ driveFolderId: root });

  onStep('Scarico l’archivio remoto…');
  const remoteFile = await findFile('fungaie.json', root);
  let remote = [];
  if (remoteFile) remote = (await (await api(`/files/${remoteFile.id}?alt=media`)).json()).finds || [];

  const local = await fdb.all();
  const map = new Map(local.map((f) => [f.id, f]));
  let downloaded = 0, uploaded = 0;
  for (const r of remote) {
    const l = map.get(r.id);
    if (!l || (r.updatedAt || '') > (l.updatedAt || '')) {
      // conserva eventuali lavori in sospeso locali
      map.set(r.id, { ...r }); await fdb.put(r); downloaded++;
    }
  }

  onStep('Carico le foto…');
  for (const raw of map.values()) {
    const f = normalizeFind(raw);
    if (f !== raw) map.set(f.id, f);
    let touched = false;
    const allPhotos = (f.visits || []).flatMap((v) => v.photos || []);
    for (const ph of allPhotos) {
      const rec = await pdb.get(ph.id);
      if (!ph.driveId && rec?.blob) {
        ph.driveId = await uploadFile({ name: `${ph.id}.jpg`, parent: photoDir, blob: rec.blob });
        rec.driveId = ph.driveId; await pdb.put(rec); touched = true; uploaded++;
      } else if (ph.driveId && !rec) {
        // foto presente su Drive ma non su questo dispositivo
        const blob = await (await api(`/files/${ph.driveId}?alt=media`)).blob();
        const { compressImage } = await import('./finds.js');
        const { thumb } = await compressImage(blob, 1600);
        await pdb.put({ id: ph.id, findId: f.id, blob, thumb, driveId: ph.driveId, createdAt: f.createdAt });
      }
    }
    if (touched) f.updatedAt = new Date().toISOString();
    if (touched || f !== raw) await fdb.put(f);
  }

  // analisi fatte con l'app (per confrontarle con quello che hai trovato davvero)
  onStep('Carico le analisi…');
  let analyses = 0;
  try {
    const hist = (await kv.get('analysisHistory')) || [];
    const todo = hist.filter((x) => !x.uploaded);
    if (todo.length) {
      const dir = await ensureFolder('analisi', root);
      for (const x of todo) {
        const t = new Date(x.createdAt);
        const pad = (n) => String(n).padStart(2, '0');
        const name = `analisi-${x.date}-ore${pad(t.getHours())}${pad(t.getMinutes())}-${x.radius}km-${x.center.lat.toFixed(3)}_${x.center.lon.toFixed(3)}.json`;
        const body = new Blob([JSON.stringify({ ...x, uploaded: undefined }, null, 1)], { type: 'application/json' });
        await uploadFile({ name, parent: dir, blob: body });
        x.uploaded = true; analyses++;
      }
      await kv.set('analysisHistory', hist);
    }
  } catch (e) { console.warn('analisi su Drive', e); }

  onStep('Salvo l’archivio su Drive…');
  const all = [...map.values()];
  const body = new Blob([JSON.stringify({ app: 'cerca-porcini', savedAt: new Date().toISOString(), finds: all }, null, 1)], { type: 'application/json' });
  await uploadFile({ id: remoteFile?.id, name: 'fungaie.json', parent: root, blob: body });
  await saveSettings({ lastSync: new Date().toISOString() });
  return { downloaded, uploaded, analyses, total: all.filter((f) => !f.deleted).length };
}
