// Fungaie: salvataggio (anche offline), foto, completamento dati quando torna la rete
import { finds as fdb, photos as pdb, uid } from './db.js';
import { terrainAtPoint } from './dem.js';
import { temperatureAt, fetchDaily, fetchDailyArchive } from './weather.js';
import { aspectLabel } from './geo.js';
import { SPECIES, GROUPS } from './config.js';
import { rainEpisodes, forestByElevation, forestTempOffset } from './engine.js';

export async function compressImage(file, max = 1600, quality = 0.82) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
  const t = document.createElement('canvas');
  const ts = 240 / Math.max(c.width, c.height);
  t.width = Math.round(c.width * ts); t.height = Math.round(c.height * ts);
  t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
  const thumb = await new Promise((r) => t.toBlob(r, 'image/jpeg', 0.7));
  return { blob, thumb };
}

export async function saveFind(data, newFiles = []) {
  const now = new Date().toISOString();
  const f = {
    id: data.id || uid(),
    createdAt: data.createdAt || now,
    updatedAt: now,
    deleted: false,
    photos: [],
    pending: { temperature: true, terrain: true, snapshot: true },
    ...data,
  };
  f.updatedAt = now;
  for (const file of newFiles) {
    const { blob, thumb } = await compressImage(file);
    const pid = uid();
    await pdb.put({ id: pid, findId: f.id, blob, thumb, driveId: null, createdAt: now });
    f.photos = [...(f.photos || []), { id: pid, driveId: null }];
  }
  await fdb.put(f);
  return f;
}

export async function deleteFind(id) {
  const f = await fdb.get(id);
  if (!f) return;
  f.deleted = true; f.updatedAt = new Date().toISOString();
  await fdb.put(f);
}

export async function listFinds() {
  return (await fdb.all()).filter((f) => !f.deleted).sort((a, b) => (b.datetime || '').localeCompare(a.datetime || ''));
}

function groupOf(f) {
  if (f.species && SPECIES[f.species]) return SPECIES[f.species].group;
  const m = Number((f.datetime || '').slice(5, 7));
  const fk = f.forestKey || forestByElevation(f.elevation ?? 800).key;
  if (fk === 'quercia' && m >= 5 && m <= 9) return 'caldo';
  return 'fresco';
}

// Completa i dati mancanti delle fungaie (quando c'è rete). Ritorna quante ne ha aggiornate.
export async function processPending(settings) {
  if (!navigator.onLine) return 0;
  const all = await fdb.all();
  let n = 0;
  for (const f of all) {
    if (f.deleted || !f.pending) continue;
    const p = f.pending;
    let changed = false;
    try {
      if (p.terrain) {
        const t = await terrainAtPoint(f.lat, f.lon);
        f.elevation = Math.round(t.elevation); f.slope = Math.round(t.slope); f.aspect = Math.round(t.aspect);
        f.aspectLabel = aspectLabel(t.aspect, t.slope);
        p.terrain = false; changed = true;
      }
      if (p.temperature) {
        if (f.temperature == null || f.tempSource === 'auto') {
          const w = await temperatureAt(f.lat, f.lon, f.datetime);
          if (w.temp != null) {
            // correzione dalla quota del modello a quella reale non disponibile qui: dato orario del modello
            f.temperature = Math.round(w.temp * 10) / 10; f.humidity = w.humidity; f.tempSource = 'auto';
          }
        }
        p.temperature = false; changed = true;
      }
      if (p.snapshot && !p.terrain) {
        const date = f.datetime.slice(0, 10);
        const ageDays = Math.ceil((Date.now() - new Date(date).getTime()) / 864e5);
        let w = null;
        if (ageDays <= 85) {
          [w] = await fetchDaily([{ lat: f.lat, lon: f.lon }], { pastDays: Math.min(92, ageDays + settings.rainWindowDays + 2), forecastDays: 1 });
        } else {
          // fungaie inserite a posteriori: archivio storico
          const from = new Date(date + 'T12:00:00'); from.setDate(from.getDate() - settings.rainWindowDays - 2);
          w = await fetchDailyArchive(f.lat, f.lon, from.toISOString().slice(0, 10), date);
        }
        if (w) {
          const idx = w.days.findIndex((d) => d.date === date);
          if (idx > 0) {
            const g = settings.gradient;
            const dT = ((f.elevation - w.elevation) * g) / 100;
            const win = w.days.slice(Math.max(0, idx - settings.windowDays), idx);
            const meanT = win.reduce((a, d) => a + (d.tmax + d.tmin) / 2, 0) / win.length - dT;
            const eps = rainEpisodes(w.days, idx - settings.rainWindowDays, idx - 1, settings.rainEventMm);
            const last = eps[eps.length - 1];
            const rain = w.days.slice(Math.max(0, idx - settings.rainWindowDays), idx).reduce((a, d) => a + (d.rain ?? 0), 0);
            const group = groupOf(f);
            const expo = f.slope >= 3 ? -Math.cos((f.aspect * Math.PI) / 180) * Math.min(1, f.slope / 12) * ((settings.southOffsetM * g) / 100) : 0;
            f.snapshot = {
              meanT: Math.round(meanT * 10) / 10,
              groundT: Math.round((meanT + expo + forestTempOffset(f.elevation, f.forestKey)) * 10) / 10,
              daysSince: last ? idx - last.endIdx : null,
              rainTotal: Math.round(rain),
              group,
              forestKey: f.forestKey || forestByElevation(f.elevation).key,
            };
          }
        }
        p.snapshot = false; changed = true;
      }
    } catch (e) { console.warn('pending', f.id, e); }
    if (!p.terrain && !p.temperature && !p.snapshot) delete f.pending;
    if (changed) { f.updatedAt = new Date().toISOString(); await fdb.put(f); n++; }
  }
  return n;
}

// ---------- Apprendimento dai ritrovamenti ----------
export function computeLearn(allFinds) {
  const fs = allFinds.filter((f) => !f.deleted && f.snapshot && !f.negative);
  const out = { n: fs.length, caldo: { tShift: 0, n: 0 }, fresco: { tShift: 0, n: 0 }, timer: { quercia: 0, faggio: 0 }, timerN: { quercia: 0, faggio: 0 } };
  const K = 4; // quanto "pesano" le regole di base rispetto ai tuoi dati
  for (const gk of Object.keys(GROUPS)) {
    const xs = fs.filter((f) => f.snapshot.group === gk && f.snapshot.groundT != null);
    if (!xs.length) continue;
    const center = (GROUPS[gk].tMin + GROUPS[gk].tMax) / 2;
    const m = xs.reduce((a, f) => a + (f.snapshot.groundT - center), 0) / xs.length;
    out[gk] = { tShift: Math.max(-3, Math.min(3, (m * xs.length) / (xs.length + K))), n: xs.length };
  }
  const centers = { quercia: 10, faggio: 18 };
  for (const fk of ['quercia', 'faggio']) {
    const xs = fs.filter((f) => f.snapshot.forestKey === fk && f.snapshot.daysSince != null);
    if (!xs.length) continue;
    const m = xs.reduce((a, f) => a + (f.snapshot.daysSince - centers[fk]), 0) / xs.length;
    out.timer[fk] = Math.round(Math.max(-6, Math.min(6, (m * xs.length) / (xs.length + K))));
    out.timerN[fk] = xs.length;
  }
  return out;
}
