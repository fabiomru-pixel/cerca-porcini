// Copia i file dell'app web in www/ per Capacitor (app Android). Nessuna trasformazione: stesso codice del sito.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'www');
const items = ['index.html', 'manifest.webmanifest', 'css', 'js', 'vendor', 'icons', 'data'];
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const it of items) {
  const src = path.join(root, it);
  if (!fs.existsSync(src)) continue;
  fs.cpSync(src, path.join(out, it), { recursive: true, filter: (p) => !/desktop\.ini$|\.DS_Store$/i.test(p) });
}
console.log('www pronto:', fs.readdirSync(out).join(', '));
