// Scarica la pioggia giornaliera degli ultimi 30 giorni dai pluviometri automatici del
// Servizio Idrologico Regionale della Toscana (SIR) e la salva in data/pluviometri.json.
// Gira con GitHub Actions (.github/workflows/pluviometri.yml) oppure a mano: node scripts/pluviometri.mjs
// Dati SIR: trasmessi in automatico, non validati (possono contenere errori): l'app usa la mediana
// delle stazioni vicine e scarta quelle fuori scala.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; CercaPorcini/1.0; uso personale)' };
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'pluviometri.json');
const DEADLINE = Date.now() + 14 * 60 * 1000; // entro 14 minuti salvo comunque quello che ho
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

async function get(url, tries = 2) {
  let last;
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
      if (r.ok) return await r.text();
      last = new Error(`HTTP ${r.status}`);
    } catch (e) { last = e; }
    await sleep(1500);
  }
  throw new Error(`${url.slice(0, 90)}: ${last?.message}`);
}

log('Scarico l\'elenco delle stazioni…');
const list = JSON.parse(await get('https://www.sir.toscana.it/open_layers/ajax_stations.php?bbox=9.5,42.2,12.5,44.6&zoom=12&types=pluvio', 3));
const stations = list.features
  .filter((f) => /Stazione autom/.test(f.description))
  .map((f) => ({ id: f.id, n: f.name, lat: f.lat, lon: f.lon, el: Math.round(Number((f.description.match(/Quota staz\. slm \[m\]<\/b>\s*([\d.]+)/) || [])[1] || 0)) }));
log('Stazioni automatiche:', stations.length);

const out = [];
const allDays = new Set();
let fails = 0, done = 0;
const queue = [...stations];
async function worker() {
  while (queue.length && Date.now() < DEADLINE) {
    const s = queue.shift();
    try {
      const h = await get(`https://www.sir.toscana.it/monitoraggio/dettaglio.php?id=${s.id}&type=pluvio_men`);
      const r = {};
      for (const m of h.matchAll(/new Array\("\d+","(\d\d)\/(\d\d)\/(\d{4})","[^"]*","([^"]*)"\)/g)) {
        const d = `${m[3]}-${m[2]}-${m[1]}`;
        r[d] = m[4] === '' ? 0 : Number(m[4]);
        allDays.add(d);
      }
      if (Object.keys(r).length >= 10) out.push({ ...s, r });
    } catch (e) {
      fails++;
      if (fails <= 3) log('Errore:', e.message);
      // se le prime richieste falliscono tutte, il sito non è raggiungibile da qui: inutile insistere
      if (done < 12 && fails >= 8) { log('Il sito SIR non risponde da questo server: interrompo.'); process.exit(1); }
    }
    done++;
    if (done % 50 === 0) log(`${done}/${stations.length} stazioni, ${out.length} valide`);
    await sleep(60);
  }
}
await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
log(`Scaricate ${out.length} stazioni su ${stations.length}`);

// Se il SIR ha risposto solo in parte (succede dai server di GitHub), tengo i dati precedenti delle
// stazioni mancanti per i giorni in comune: meglio un dato di ieri che nessun dato.
let prev = null;
try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { prev = null; }
if (prev?.stations?.length) {
  const have = new Set(out.map((x) => x.id));
  let kept = 0;
  for (const p of prev.stations) {
    if (have.has(p.id)) continue;
    const r = {};
    prev.days.forEach((d, i) => { if (p.r[i] != null) { r[d] = p.r[i]; allDays.add(d); } });
    if (Object.keys(r).length >= 10) { out.push({ id: p.id, n: p.n, lat: p.lat, lon: p.lon, el: p.el, r }); kept++; }
  }
  if (kept) log(`Recuperate dal file precedente ${kept} stazioni non scaricate in questo giro`);
}
if (out.length < 300) { log(`Troppo poche stazioni (${out.length}): non sovrascrivo il file.`); process.exit(1); }

// il giorno corrente è parziale: lo escludo
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
const days = [...allDays].filter((d) => d < today).sort();
const data = {
  source: 'SIR Toscana – Servizio Idrologico Regionale (dati automatici non validati)',
  updated: new Date().toISOString(),
  days,
  stations: out.map((s) => ({ id: s.id, n: s.n, lat: s.lat, lon: s.lon, el: s.el, r: days.map((d) => (s.r[d] == null ? null : Math.round(s.r[d] * 10) / 10)) })),
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(data));
log(`Salvato: ${out.length} stazioni, ${days.length} giorni (${days[0]} → ${days[days.length - 1]}), ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB, ${fails} errori`);
