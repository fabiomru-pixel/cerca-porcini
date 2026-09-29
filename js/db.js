// Piccolo wrapper IndexedDB: impostazioni, fungaie, foto, cache analisi.
const DB_NAME = 'cerca-porcini';
const DB_VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('finds')) db.createObjectStore('finds', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((r) => { out = r; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const kv = {
  get: (k) => tx('kv', 'readonly', (s) => reqP(s.get(k))),
  set: (k, v) => tx('kv', 'readwrite', (s) => { s.put(v, k); }),
  del: (k) => tx('kv', 'readwrite', (s) => { s.delete(k); }),
};

export const finds = {
  all: () => tx('finds', 'readonly', (s) => reqP(s.getAll())),
  get: (id) => tx('finds', 'readonly', (s) => reqP(s.get(id))),
  put: (f) => tx('finds', 'readwrite', (s) => { s.put(f); }),
  del: (id) => tx('finds', 'readwrite', (s) => { s.delete(id); }),
};

export const photos = {
  all: () => tx('photos', 'readonly', (s) => reqP(s.getAll())),
  get: (id) => tx('photos', 'readonly', (s) => reqP(s.get(id))),
  put: (p) => tx('photos', 'readwrite', (s) => { s.put(p); }),
  del: (id) => tx('photos', 'readwrite', (s) => { s.delete(id); }),
};

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
