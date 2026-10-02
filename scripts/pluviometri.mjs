// Scarica la pioggia giornaliera degli ultimi 30 giorni dai pluviometri automatici del
// Servizio Idrologico Regionale della Toscana (SIR) e la salva in data/pluviometri.json.
// Gira ogni notte con GitHub Actions (.github/workflows/pluviometri.yml); l'app legge il file
// dallo stesso sito, senza chiamare il SIR dal telefono.
// Dati SIR: trasmessi in automatico, non validati (possono contenere errori): l'app usa la mediana
// delle stazioni vicine e scarta quelle fuori scala.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UA = { 'User-Agent': 'CercaPorcini/1.0 (uso personale; https://fabiomru-pixel.github.io/cerca-porcini/)' };
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'pluviometri.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (r.ok) return await r.text();
    } catch { /* riprova */ }
    await sleep(2000 * (a + 1));
  }
  throw new Error(`Impossibile scaricare ${url}`);
}

const list = JSON.parse(await get('https://www.sir.toscana.it/open_layers/ajax_stations.php?bbox=9.5,42.2,12.5,44.6&zoom=12&types=pluvio'));
const stations = list.features
  .filter((f) => /Stazione autom/.test(f.description))
  .map((f) => ({ id: f.id, n: f.name, lat: f.lat, lon: f.lon, el: Math.round(Number((f.description.match(/Quota staz\. slm \[m\]<\/b>\s*([\d.]+)/) || [])[1] || 0)) }));
console.log('Stazioni automatiche:', stations.length);

const out = [];
const allDays = new Set();
let ok = 0;
for (const s of stations) {
  try {
    const h = await get(`https://www.sir.toscana.it/monitoraggio/dettaglio.php?id=${s.id}&type=pluvio_men`);
    const r = {};
    for (const m of h.matchAll(/new Array\("\d+","(\d\d)\/(\d\d)\/(\d{4})","[^"]*","([^"]*)"\)/g)) {
      const d = `${m[3]}-${m[2]}-${m[1]}`;
      r[d] = m[4] === '' ? 0 : Number(m[4]);
      allDays.add(d);
    }
    if (Object.keys(r).length >= 10) { out.push({ ...s, r }); ok++; }
  } catch (e) { console.warn(s.id, e.message); }
  await sleep(120); // con garbo verso il server del SIR
}

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
console.log(`Salvato ${OUT}: ${ok} stazioni, ${days.length} giorni (${days[0]} → ${days[days.length - 1]}), ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
