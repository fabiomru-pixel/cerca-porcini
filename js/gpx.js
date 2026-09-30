// Esportazione GPX (compatibile con Mapy.com, OruxMaps, Locus, Garmin)
import { distKm } from './geo.js';
import { GROUPS } from './config.js';

const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const n6 = (v) => Number(v).toFixed(6);

export function buildGpx(analysis, finds = [], { nearKm = 3, car = null } = {}) {
  const parts = [];
  const name = `Porcini ${analysis ? analysis.date : new Date().toISOString().slice(0, 10)}`;
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push('<gpx version="1.1" creator="Cerca Porcini" xmlns="http://www.topografix.com/GPX/1/1">');
  parts.push(`<metadata><name>${esc(name)}</name><time>${new Date().toISOString()}</time></metadata>`);

  if (analysis) {
    for (const s of analysis.spots) {
      const desc = [
        `Punteggio ${s.score}/100 (luogo ${s.place}, tempismo ${s.timing})`,
        `Quota ${s.elevation} m, esposizione ${s.aspectLabel}, pendenza ${s.slope}°`,
        `${s.forest}${s.forestType ? ' (' + s.forestType + ')' : ''}${s.edge ? ', margine/radura' : ''}`,
        `Specie: ${s.species.join(', ')}`,
        `T stimata al suolo ${s.tLocal} °C; pioggia 20 gg ${s.rainTotal} mm` + (s.daysSince != null ? `; ${s.daysSince} gg dalla pioggia` : ''),
        s.killers.length ? `Attenzione: ${s.killers.join(', ')}` : '',
        s.protected ? `AREA PROTETTA: ${s.protected.name} – verifica il regolamento` : '',
      ].filter(Boolean).join('\n');
      parts.push(`<wpt lat="${n6(s.lat)}" lon="${n6(s.lon)}"><ele>${s.elevation}</ele><name>${esc(`${s.id} ★${s.score} ${s.elevation}m`)}</name><desc>${esc(desc)}</desc><sym>Flag, Green</sym><type>Spot consigliato</type></wpt>`);
    }
  }
  if (car) {
    parts.push(`<wpt lat="${n6(car.lat)}" lon="${n6(car.lon)}"><time>${car.savedAt}</time><name>Auto</name><desc>Auto parcheggiata</desc><sym>Parking Area</sym><type>Auto</type></wpt>`);
  }
  for (const f of finds.filter((x) => !x.deleted)) {
    const when = new Date(f.datetime);
    const desc = [
      `Trovata il ${when.toLocaleString('it-IT')}`,
      f.species ? `Specie: ${f.species}` : '',
      f.quantity ? `Quantità: ${f.quantity}` : '',
      f.temperature != null ? `Temperatura: ${f.temperature} °C` : '',
      f.elevation != null ? `Quota ${Math.round(f.elevation)} m, esposizione ${f.aspectLabel || '-'}` : '',
      f.forest ? `Bosco: ${f.forest}` : '',
      f.notes || '',
    ].filter(Boolean).join('\n');
    parts.push(`<wpt lat="${n6(f.lat)}" lon="${n6(f.lon)}">${f.elevation != null ? `<ele>${Math.round(f.elevation)}</ele>` : ''}<time>${when.toISOString()}</time><name>${esc(`Fungaia ${when.toLocaleDateString('it-IT')}`)}</name><desc>${esc(desc)}</desc><sym>Pin, Red</sym><type>Fungaia</type></wpt>`);
  }

  if (analysis) {
    const anchors = [...analysis.spots, ...finds.filter((f) => !f.deleted)];
    const near = (p) => anchors.some((a) => distKm(a, { lat: p[0], lon: p[1] }) <= nearKm);
    const doneLevels = new Set();
    for (const [gk, c] of Object.entries(analysis.contours)) {
      for (const [lvl, lines] of [[c.lo, c.loLines], [c.hi, c.hiLines]]) {
        if (doneLevels.has(lvl)) continue; // stessa quota già esportata per l'altro gruppo
        doneLevels.add(lvl);
        const segs = [];
        for (const line of lines) {
          let cur = [];
          for (const p of line) {
            if (near(p)) cur.push(p); else { if (cur.length > 1) segs.push(cur); cur = []; }
          }
          if (cur.length > 1) segs.push(cur);
        }
        if (!segs.length) continue;
        parts.push(`<trk><name>${esc(`Quota ${lvl} m – ${GROUPS[gk].label}`)}</name><desc>${esc(`Limite della fascia consigliata ${c.lo}–${c.hi} m`)}</desc>`);
        for (const sg of segs) {
          parts.push('<trkseg>' + sg.map((p) => `<trkpt lat="${n6(p[0])}" lon="${n6(p[1])}"><ele>${lvl}</ele></trkpt>`).join('') + '</trkseg>');
        }
        parts.push('</trk>');
      }
    }
  }
  parts.push('</gpx>');
  return parts.join('\n');
}

export async function shareOrDownload(text, filename) {
  const blob = new Blob([text], { type: 'application/gpx+xml' });
  const file = new File([blob], filename, { type: 'application/gpx+xml' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return 'shared'; } catch (e) { if (e.name === 'AbortError') return 'cancel'; }
  }
  download(blob, filename);
  return 'downloaded';
}

export function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
