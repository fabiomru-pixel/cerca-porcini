// Cloudflare Worker "sir-pluviometri": legge la pioggia giornaliera dei pluviometri SIR Toscana
// e la restituisce all'app Cerca Porcini (il sito SIR non permette la lettura diretta dal browser).
// Uso: https://<worker>.workers.dev/?ids=TOS11000114,TOS01001234   (max 40 stazioni per richiesta)
// Risposta: { updated, stations: { TOS11000114: { "2026-10-08": 15.5, ... } }, failed: [...] }

const MAX_IDS = 40;
const CACHE_S = 1800; // 30 minuti: il SIR aggiorna i dati ogni mezz'ora circa

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
};

async function station(id, ctx) {
  const url = `https://www.sir.toscana.it/monitoraggio/dettaglio.php?id=${id}&type=pluvio_men`;
  const cache = caches.default;
  const key = new Request(url);
  let res = await cache.match(key);
  if (!res) {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CercaPorcini/1.0; uso personale)' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();
    const days = {};
    for (const m of html.matchAll(/new Array\("\d+","(\d\d)\/(\d\d)\/(\d{4})","[^"]*","([^"]*)"\)/g)) {
      days[`${m[3]}-${m[2]}-${m[1]}`] = m[4] === '' ? 0 : Number(m[4]); // vuoto = niente pioggia (come nel file)
    }
    res = new Response(JSON.stringify(days), { headers: { 'Cache-Control': `max-age=${CACHE_S}` } });
    ctx.waitUntil(cache.put(key, res.clone()));
  }
  return res.json();
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const ids = (new URL(req.url).searchParams.get('ids') || '')
      .split(',').map((s) => s.trim()).filter((s) => /^TOS\d{8}$/.test(s)).slice(0, MAX_IDS);
    if (!ids.length) return new Response(JSON.stringify({ error: 'ids mancanti' }), { status: 400, headers: CORS });
    const stations = {};
    const failed = [];
    await Promise.all(ids.map(async (id) => {
      try { stations[id] = await station(id, ctx); } catch { failed.push(id); }
    }));
    return new Response(JSON.stringify({ updated: new Date().toISOString(), stations, failed }), { headers: CORS });
  },
};
