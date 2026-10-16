// Dopo "npx cap add android": permessi (GPS anche a schermo spento, notifica, vibrazione), icone e versione.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = path.join(root, 'android', 'app');

// 1. permessi
const mf = path.join(app, 'src', 'main', 'AndroidManifest.xml');
let xml = fs.readFileSync(mf, 'utf8');
const perms = [
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_LOCATION',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.VIBRATE',
  'android.permission.WAKE_LOCK',
  'android.permission.REQUEST_INSTALL_PACKAGES', // per installare gli aggiornamenti scaricati dall'app
];
const add = perms.filter((p) => !xml.includes(p)).map((p) => `    <uses-permission android:name="${p}" />`).join('\n');
xml = xml.replace(/<\/manifest>\s*$/, `${add}\n    <uses-feature android:name="android.hardware.location.gps" android:required="false" />\n</manifest>\n`);
fs.writeFileSync(mf, xml);

// 2. icone: icona normale e versione "adattiva" (maskable) per i launcher Android recenti
const res = path.join(app, 'src', 'main', 'res');
const icon = path.join(root, 'icons', 'icon-512.png');
const fg = path.join(root, 'icons', 'icon-maskable-512.png');
for (const d of fs.readdirSync(res).filter((d) => d.startsWith('mipmap-') && !d.includes('anydpi'))) {
  for (const f of ['ic_launcher.png', 'ic_launcher_round.png']) fs.copyFileSync(icon, path.join(res, d, f));
  fs.copyFileSync(fs.existsSync(fg) ? fg : icon, path.join(res, d, 'ic_launcher_foreground.png'));
}
const bg = path.join(res, 'values', 'ic_launcher_background.xml');
if (fs.existsSync(bg)) fs.writeFileSync(bg, '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#E4FDE1</color>\n</resources>\n');

// 3. versione: nome dalla versione dell'app web, codice dal numero di compilazione
const cfg = fs.readFileSync(path.join(root, 'js', 'config.js'), 'utf8');
const versionName = (cfg.match(/APP_VERSION = '([^']+)'/) || [])[1] || '1.0.0';
const versionCode = Number(process.env.GITHUB_RUN_NUMBER || 1);
const gradle = path.join(app, 'build.gradle');
let g = fs.readFileSync(gradle, 'utf8');
g = g.replace(/versionCode \d+/, `versionCode ${versionCode}`).replace(/versionName "[^"]*"/, `versionName "${versionName}"`);
fs.writeFileSync(gradle, g);
console.log(`Android pronto: versione ${versionName} (${versionCode})`);
