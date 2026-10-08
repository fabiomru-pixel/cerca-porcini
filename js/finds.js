// Fungaie (luoghi) con i loro ritrovamenti nel tempo, uscite a vuoto, foto,
// completamento dei dati quando torna la rete e apprendimento dai risultati.
import { finds as fdb, photos as pdb, uid } from './db.js';
import { terrainAtPoint } from './dem.js';
import { temperatureAt, fetchDaily, fetchDailyArchive } from './weather.js';
import { aspectLabel } from './geo.js';
import { SPECIES, GROUPS } from './config.js';
import { rainEpisodes, forestByElevation, forestTempOffset, soilMoisture, forestTimer, addDays } from './engine.js';
import { climateFor, tempClass, regimeOf } from './climate.js';
import { loadGauges, applyGauges } from './gauges.js';

export const AGES = { nuovo: 'Appena nato', maturo: 'Maturo', vecchio: 'Vecchio' };
export const STATES = { sano: 'Ottimo / sano', bacato: 'Mangiato / bacato', rotto: 'Rotto da calore o vento' };
const TIMER_CENTER = { quercia: 10, faggio: 18 }; // centro della finestra migliore (slide)
const K = 4; // le regole di base valgono come 4 ritrovamenti

const todayStr = () => new Date().toLocaleDateString('sv-SE');

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

// ---------------------------------------------------------------- struttura dati
// Converte le fungaie della prima versione (un solo ritrovamento) nel formato luogo + ritrovamenti
export function normalizeFind(f) {
  if (!f || Array.isArray(f.visits)) return f;
  const q = String(f.quantity || '');
  const count = parseInt(q.match(/\d+/)?.[0] || '', 10);
  const kg = q.match(/(\d+(?:[.,]\d+)?)\s*kg/i);
  const gr = q.match(/(\d+)\s*g(?:r|rammi)?\b/i);
  const visit = {
    id: `${f.id}-v1`,
    datetime: f.datetime,
    count: Number.isFinite(count) && !kg && !gr ? count : 1,
    weightKg: kg ? Number(kg[1].replace(',', '.')) : gr ? Number(gr[1]) / 1000 : null,
    species: f.species || null, age: null, state: null,
    temperature: f.temperature ?? null, tempSource: f.tempSource || null, humidity: f.humidity ?? null,
    // la quantità originale resta nelle note solo se non era un semplice numero di esemplari
    notes: [f.notes, q && (!Number.isFinite(count) || kg || gr) ? `Quantità: ${q}` : ''].filter(Boolean).join('\n'),
    photos: f.photos || [],
    snapshot: null,
    pending: { temperature: !!f.pending?.temperature, snapshot: true }, // ricalcolo con suolo e situazione
    createdAt: f.createdAt, updatedAt: f.updatedAt,
  };
  const place = { ...f, visits: [visit] };
  for (const k of ['datetime', 'species', 'quantity', 'temperature', 'tempSource', 'humidity', 'photos', 'snapshot', 'notes']) delete place[k];
  place.pending = f.pending?.terrain ? { terrain: true } : undefined;
  if (!place.pending) delete place.pending;
  return place;
}

// "altro fungo" (es. mazze di tamburo): resta in archivio ma non conta né come porcini né come uscita a vuoto
export const isOther = (v) => v.kind === 'altro';
export const isPositive = (v) => (v.count || 0) > 0 && !isOther(v);
export function placeSummary(f) {
  const vs = [...(f.visits || [])].sort((a, b) => (b.datetime || '').localeCompare(a.datetime || ''));
  const pos = vs.filter(isPositive);
  const other = vs.filter(isOther);
  return {
    other, nOther: other.length,
    visits: vs, last: vs[0] || null, lastPositive: pos[0] || null,
    nPos: pos.length, nNeg: vs.length - pos.length - other.length,
    total: pos.reduce((a, v) => a + (v.count || 0), 0),
    weight: pos.reduce((a, v) => a + (v.weightKg || 0), 0),
    emptyOnly: vs.length > 0 && !pos.length && !other.length,
    otherOnly: other.length > 0 && !pos.length,
    first: vs[vs.length - 1] || null,
  };
}

// Giorno ideale di raccolta rispetto al giorno del ritrovamento, da età e stato del fungo
export function visitOffset(v) {
  if (!isPositive(v)) return null;
  if (v.age === 'vecchio') return { days: -3, why: 'vecchio: andava raccolto ~3 giorni prima' };
  if (v.state === 'rotto') {
    const adv = v.snapshot?.adverse;
    if (adv?.any) return { days: 0, why: `rotto da ${[adv.heat && 'caldo anomalo', adv.wind && 'vento forte'].filter(Boolean).join(' e ')}: nessuna correzione` };
    return { days: -1, why: 'rotto senza caldo o vento rilevati: leggermente tardi' };
  }
  let d = v.age === 'nuovo' ? 2 : 0;
  if (v.state === 'bacato') d -= 1;
  const why = v.age === 'nuovo' ? (d === 2 ? 'appena nato: ideale ~2 giorni dopo' : 'appena nato ma bacato: ideale ~1 giorno dopo')
    : v.age === 'maturo' ? (d === 0 ? 'maturo e sano: tempismo perfetto' : 'maturo bacato: ~1 giorno tardi')
      : (d ? 'bacato: ~1 giorno tardi' : 'età non indicata');
  return { days: d, why };
}

// ---------------------------------------------------------------- salvataggio
async function storePhotos(placeId, visitId, files) {
  const out = [];
  for (const file of files) {
    const { blob, thumb } = await compressImage(file);
    const pid = uid();
    await pdb.put({ id: pid, findId: placeId, visitId, blob, thumb, driveId: null, createdAt: new Date().toISOString() });
    out.push({ id: pid, driveId: null });
  }
  return out;
}

const newVisit = (data) => ({
  id: uid(), createdAt: new Date().toISOString(), photos: [], snapshot: null,
  pending: { temperature: data.tempSource !== 'manual', snapshot: true },
  ...data,
});

export async function createPlace(placeData, visitData, files = []) {
  const now = new Date().toISOString();
  const place = { id: uid(), createdAt: now, updatedAt: now, deleted: false, pending: { terrain: true }, ...placeData, visits: [] };
  const v = newVisit(visitData);
  v.photos = await storePhotos(place.id, v.id, files);
  v.updatedAt = now;
  place.visits.push(v);
  await fdb.put(place);
  return place;
}

export async function addVisit(placeId, visitData, files = []) {
  const place = normalizeFind(await fdb.get(placeId));
  const v = newVisit(visitData);
  v.photos = await storePhotos(place.id, v.id, files);
  v.updatedAt = place.updatedAt = new Date().toISOString();
  place.visits.push(v);
  await fdb.put(place);
  return place;
}

export async function updateVisit(placeId, visitId, data, files = [], removedPhotoIds = []) {
  const place = normalizeFind(await fdb.get(placeId));
  const v = place.visits.find((x) => x.id === visitId);
  if (!v) throw new Error('Ritrovamento non trovato');
  const timeChanged = data.datetime && data.datetime !== v.datetime;
  Object.assign(v, data);
  for (const id of removedPhotoIds) await pdb.del(id);
  v.photos = (v.photos || []).filter((p) => !removedPhotoIds.includes(p.id)).concat(await storePhotos(place.id, v.id, files));
  v.pending = { ...(v.pending || {}) };
  if (timeChanged || v.tempSource !== 'manual') v.pending.temperature = v.tempSource !== 'manual';
  v.pending.snapshot = true; // età/stato/data possono cambiare l'interpretazione
  v.updatedAt = place.updatedAt = new Date().toISOString();
  await fdb.put(place);
  return place;
}

export async function deleteVisit(placeId, visitId) {
  const place = normalizeFind(await fdb.get(placeId));
  const v = place.visits.find((x) => x.id === visitId);
  for (const p of v?.photos || []) await pdb.del(p.id);
  place.visits = place.visits.filter((x) => x.id !== visitId);
  place.updatedAt = new Date().toISOString();
  if (!place.visits.length) place.deleted = true;
  await fdb.put(place);
  return place;
}

export async function updatePlace(placeId, data) {
  const place = normalizeFind(await fdb.get(placeId));
  const moved = (data.lat != null && Math.abs(data.lat - place.lat) > 1e-6) || (data.lon != null && Math.abs(data.lon - place.lon) > 1e-6);
  Object.assign(place, data);
  if (moved) {
    place.pending = { ...(place.pending || {}), terrain: true };
    for (const v of place.visits) v.pending = { ...(v.pending || {}), temperature: v.tempSource !== 'manual', snapshot: true };
  }
  place.updatedAt = new Date().toISOString();
  await fdb.put(place);
  return place;
}

export async function deleteFind(id) {
  const f = await fdb.get(id);
  if (!f) return;
  f.deleted = true; f.updatedAt = new Date().toISOString();
  await fdb.put(f);
}

// Converte e salva una volta le fungaie del vecchio formato
export async function migrateFinds() {
  let n = 0;
  for (const f of await fdb.all()) {
    if (f && !Array.isArray(f.visits)) { await fdb.put(normalizeFind(f)); n++; }
  }
  return n;
}

export async function listFinds() {
  return (await fdb.all()).filter((f) => !f.deleted).map(normalizeFind)
    .sort((a, b) => (placeSummary(b).last?.datetime || '').localeCompare(placeSummary(a).last?.datetime || ''));
}

// ---------------------------------------------------------------- dati meteo del ritrovamento
function groupOf(place, v) {
  if (v.species && SPECIES[v.species]) return SPECIES[v.species].group;
  const m = Number((v.datetime || '').slice(5, 7));
  const fk = place.forestKey || forestByElevation(place.elevation ?? 800).key;
  if (fk === 'quercia' && m >= 5 && m <= 9) return 'caldo';
  return 'fresco';
}

async function dailyAround(lat, lon, date, before = 45) {
  const ageDays = Math.ceil((Date.now() - new Date(date + 'T12:00:00').getTime()) / 864e5);
  if (ageDays + before <= 88) {
    const [w] = await fetchDaily([{ lat, lon }], { pastDays: Math.max(1, ageDays + before), forecastDays: 1 });
    return w;
  }
  return fetchDailyArchive(lat, lon, addDays(date, -before), date);
}

// Versione del calcolo meteo dei ritrovamenti: quando cambia, i dati salvati vengono ricalcolati da soli
// 2 = pioggia da media di 3 modelli + pluviometri SIR (le fungaie salvate prima usavano il vecchio modello)
export const SNAPSHOT_VER = 2;

async function snapshotFor(place, v, s) {
  const date = v.datetime.slice(0, 10);
  if (date > todayStr()) return null;
  const w = applyGauges(await dailyAround(place.lat, place.lon, date), await loadGauges()); // pioggia misurata se disponibile
  const idx = w.days.findIndex((d) => d.date === date);
  if (idx <= 0) return null;
  const g = s.gradient;
  const dT = ((place.elevation - w.elevation) * g) / 100;
  const win = w.days.slice(Math.max(0, idx - s.windowDays), idx);
  const meanT = win.reduce((a, d) => a + (d.tmax + d.tmin) / 2, 0) / win.length - dT;
  const meanMax = win.reduce((a, d) => a + d.tmax, 0) / win.length - dT;
  const eps = rainEpisodes(w.days, idx - s.rainWindowDays, idx - 1, s.rainEventMm);
  const last = eps[eps.length - 1];
  const rain = w.days.slice(Math.max(0, idx - s.rainWindowDays), idx).reduce((a, d) => a + (d.rain ?? 0), 0);
  const soilTheta = soilMoisture(w.days, idx - 1); // stato del suolo la mattina del ritrovamento (prima della pioggia di quel giorno)
  const expo = place.slope >= 3 ? -Math.cos((place.aspect * Math.PI) / 180) * Math.min(1, place.slope / 12) * ((s.southOffsetM * g) / 100) : 0;

  // condizioni avverse nei 7 giorni prima (per i funghi "rotti da calore o vento")
  const clim = await climateFor(place.lat, place.lon, date, place.elevation, g);
  const last7 = w.days.slice(Math.max(0, idx - 7), idx + 1);
  let maxT = -99, maxTDate = null, maxWind = 0, maxWindDate = null;
  for (const d of last7) {
    if (d.tmax - dT > maxT) { maxT = d.tmax - dT; maxTDate = d.date; }
    if ((d.wind ?? 0) > maxWind) { maxWind = d.wind; maxWindDate = d.date; }
  }
  const heat = maxT > clim.maxAnom || maxT >= 30;
  const wind = maxWind >= 30;
  const tc = tempClass({ meanT, meanMax }, clim);
  const dry = soilTheta < 0.3 || rain < s.rainMinMm;

  return {
    ver: SNAPSHOT_VER,
    rainSrc: w.rainSrc?.type === 'pluviometri' ? { type: 'pluviometri', stations: w.rainSrc.stations } : { type: 'modelli' },
    meanT: Math.round(meanT * 10) / 10,
    meanMax: Math.round(meanMax * 10) / 10,
    groundT: Math.round((meanT + expo + forestTempOffset(place.elevation, place.forestKey)) * 10) / 10,
    daysSince: last ? idx - last.endIdx : null,
    rainTotal: Math.round(rain),
    soilTheta: Math.round(soilTheta * 100) / 100,
    group: groupOf(place, v),
    forestKey: place.forestKey || forestByElevation(place.elevation).key,
    regime: regimeOf(dry ? 0 : rain, tc),
    adverse: {
      heat, wind, any: heat || wind,
      maxT: Math.round(maxT * 10) / 10, maxTDate,
      maxWind: Math.round(maxWind), maxWindDate,
      heatThreshold: Math.round(Math.min(clim.maxAnom, 30) * 10) / 10,
    },
  };
}

// Completa i dati mancanti (quando c'è rete). Ritorna quante fungaie ha aggiornato.
export async function processPending(settings) {
  if (!navigator.onLine) return 0;
  let n = 0;
  for (const raw of await fdb.all()) {
    if (!raw || raw.deleted) continue;
    const place = normalizeFind(raw);
    const migrated = place !== raw;
    let changed = migrated;
    try {
      if (place.pending?.terrain) {
        const t = await terrainAtPoint(place.lat, place.lon);
        place.elevation = Math.round(t.elevation); place.slope = Math.round(t.slope); place.aspect = Math.round(t.aspect);
        place.aspectLabel = aspectLabel(t.aspect, t.slope);
        delete place.pending; changed = true;
      }
      if (!place.pending?.terrain) {
        for (const v of place.visits) {
          // dati meteo calcolati con una versione vecchia: da rifare
          if (v.snapshot && v.snapshot.ver !== SNAPSHOT_VER && v.datetime && v.datetime.slice(0, 10) <= todayStr()) {
            v.pending = { ...(v.pending || {}), snapshot: true };
          }
          const p = v.pending;
          if (!p) continue;
          try {
            if (p.temperature) {
              if (v.datetime.slice(0, 10) <= todayStr()) {
                const w = await temperatureAt(place.lat, place.lon, v.datetime);
                if (w.temp != null) { v.temperature = Math.round(w.temp * 10) / 10; v.humidity = w.humidity; v.tempSource = 'auto'; }
              }
              p.temperature = false; changed = true;
            }
            if (p.snapshot) {
              v.snapshot = await snapshotFor(place, v, settings);
              p.snapshot = false; changed = true;
            }
          } catch (e) { console.warn('pending visit', v.id, e); }
          if (!p.temperature && !p.snapshot) delete v.pending;
        }
      }
    } catch (e) { console.warn('pending', place.id, e); }
    if (changed) { if (!migrated) place.updatedAt = new Date().toISOString(); await fdb.put(place); n++; }
  }
  return n;
}

// ---------------------------------------------------------------- apprendimento
const shrink = (sum, wsum) => sum / (wsum + K);
const clampN = (v, a, b) => Math.max(a, Math.min(b, v));

export function computeLearn(allFinds) {
  const entries = [];
  for (const raw of allFinds) {
    if (!raw || raw.deleted) continue;
    const place = normalizeFind(raw);
    for (const v of place.visits || []) if (v.snapshot && !isOther(v)) entries.push({ place, v, s: v.snapshot, pos: isPositive(v) });
  }
  const pos = entries.filter((e) => e.pos), neg = entries.filter((e) => !e.pos);
  const weight = (e) => (e.pos ? 1 + Math.log2(1 + e.v.count) / 2 : 1); // più esemplari = segnale più forte
  const out = {
    n: entries.length, nPos: pos.length, nNeg: neg.length,
    caldo: { tShift: 0, n: 0 }, fresco: { tShift: 0, n: 0 },
    timer: { quercia: 0, faggio: 0 }, timerN: { quercia: 0, faggio: 0 },
    soilShift: 0, soilN: 0,
    expo: { A: new Array(8).fill(0), B: new Array(8).fill(0), C: new Array(8).fill(0) }, expoN: { A: 0, B: 0, C: 0 },
  };

  // 1. finestra termica (solo ritrovamenti)
  for (const gk of Object.keys(GROUPS)) {
    const xs = pos.filter((e) => e.s.group === gk && e.s.groundT != null);
    if (!xs.length) continue;
    const center = (GROUPS[gk].tMin + GROUPS[gk].tMax) / 2;
    let sum = 0, ws = 0;
    for (const e of xs) { const w = weight(e); sum += w * (e.s.groundT - center); ws += w; }
    out[gk] = { tShift: clampN(shrink(sum, ws), -3, 3), n: xs.length };
  }

  // 2. timer: giorni dalla pioggia al giorno ideale (corretto con età e stato del fungo)
  for (const fk of ['quercia', 'faggio']) {
    const xs = pos.filter((e) => e.s.forestKey === fk && e.s.daysSince != null);
    if (!xs.length) continue;
    let sum = 0, ws = 0;
    for (const e of xs) {
      const ideal = e.s.daysSince + (visitOffset(e.v)?.days || 0);
      const w = weight(e); sum += w * (ideal - TIMER_CENTER[fk]); ws += w;
    }
    out.timer[fk] = Math.round(clampN(shrink(sum, ws), -6, 6));
    out.timerN[fk] = xs.length;
  }

  // 3. umidità del suolo: dove trovi con suolo più asciutto la curva diventa meno severa,
  //    le uscite a vuoto con suolo umido e timer giusto la rendono più severa
  {
    let sum = 0, ws = 0;
    for (const e of pos) if (e.s.soilTheta != null) { const w = weight(e); sum += w * (e.s.soilTheta - 0.55); ws += w; }
    let shift = ws ? shrink(sum, ws) : 0;
    let push = 0;
    for (const e of neg) {
      if (e.s.soilTheta == null || e.s.daysSince == null) continue;
      const t = forestTimer(e.s.forestKey || 'quercia');
      if (e.s.soilTheta >= 0.45 && e.s.daysSince >= t.start && e.s.daysSince <= t.end) push += 0.03;
    }
    out.soilShift = Math.round(clampN(shift + Math.min(0.1, push), -0.2, 0.2) * 100) / 100;
    out.soilN = pos.filter((e) => e.s.soilTheta != null).length + neg.filter((e) => e.s.soilTheta != null).length;
  }

  // 4. esposizione: tasso di successo per versante, separato per situazione (A, B, C)
  for (const R of ['A', 'B', 'C']) {
    const xs = entries.filter((e) => e.s.regime === R && (e.place.slope ?? 0) >= 3 && e.place.aspect != null);
    if (!xs.length) continue;
    const P = new Array(8).fill(0), N = new Array(8).fill(0);
    for (const e of xs) {
      const k = Math.round(e.place.aspect / 45) % 8;
      if (e.pos) P[k] += weight(e); else N[k] += 1;
    }
    const tp = P.reduce((a, b) => a + b, 0), tn = N.reduce((a, b) => a + b, 0);
    const r0 = (tp + 1) / (tp + tn + 2);
    out.expo[R] = P.map((p, k) => {
      const rs = (p + K * r0) / (p + N[k] + K);
      return Math.round(clampN((rs - r0) * 0.8, -0.15, 0.15) * 1000) / 1000;
    });
    out.expoN[R] = xs.length;
  }
  return out;
}

// ---------------------------------------------------------------- previsione per una fungaia
// Giorni ideali dalla pioggia per questa fungaia: dai suoi ritrovamenti, altrimenti dalle regole (affinate)
export function placeIdealDays(place, learn) {
  place = normalizeFind(place);
  const fk = place.forestKey || forestByElevation(place.elevation ?? 800).key;
  const own = placeSummary(place).visits.filter((v) => isPositive(v) && v.snapshot?.daysSince != null);
  if (own.length) {
    let sum = 0, ws = 0;
    for (const v of own) { const w = 1 + Math.log2(1 + v.count) / 2; sum += w * (v.snapshot.daysSince + (visitOffset(v)?.days || 0)); ws += w; }
    return { fk, idealDays: Math.round(sum / ws), own: own.length, source: `${own.length} ritrovament${own.length === 1 ? 'o' : 'i'} in questa fungaia` };
  }
  return { fk, idealDays: TIMER_CENTER[fk] + (learn?.timer?.[fk] || 0), own: 0, source: 'regole del bosco (nessun ritrovamento con dati meteo qui)' };
}
export { TIMER_CENTER };

// Momento ideale previsto: ultima (o prossima) pioggia utile + giorni ideali di questa fungaia
export async function predictPlace(place, s, learn) {
  place = normalizeFind(place);
  const { fk, idealDays, source } = placeIdealDays(place, learn);
  const [w0] = await fetchDaily([{ lat: place.lat, lon: place.lon }], { pastDays: 45, forecastDays: 16 });
  const w = applyGauges(w0, await loadGauges());
  const today = todayStr();
  const idx = w.days.findIndex((d) => d.date === today);
  const eps = rainEpisodes(w.days, idx - 30, w.days.length - 1, s.rainEventMm).map((e) => ({
    end: w.days[e.endIdx].date, total: Math.round(e.total), future: w.days[e.endIdx].date > today,
  }));
  const windows = eps.map((e) => ({ ...e, from: addDays(e.end, idealDays - 2), to: addDays(e.end, idealDays + 2), ideal: addDays(e.end, idealDays) }));
  const next = windows.find((x) => x.to >= today) || null;
  return { idealDays, source, fk, windows, next, soilNow: soilMoisture(w.days, idx), rainSrc: w.rainSrc };
}
