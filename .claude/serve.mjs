// server statico per le prove locali (non pubblicato)
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = process.argv[2]; const T = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.webmanifest':'application/manifest+json', '.svg':'image/svg+xml' };
http.createServer((q, r) => { let p = decodeURIComponent(q.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
  fs.readFile(path.join(root, p), (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': T[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); r.end(d); }); }).listen(Number(process.env.PORT) || 8765);
