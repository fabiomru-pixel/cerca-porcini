// Utilità geografiche (Web Mercator, distanze, esposizione)
const R = 6371008.8;
export const toRad = (d) => (d * Math.PI) / 180;
export const toDeg = (r) => (r * 180) / Math.PI;

export function distKm(a, b) {
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return (2 * R * Math.asin(Math.sqrt(s))) / 1000;
}

export function bboxAround(lat, lon, km) {
  const dLat = km / 111.32;
  const dLon = km / (111.32 * Math.cos(toRad(lat)));
  return { south: lat - dLat, north: lat + dLat, west: lon - dLon, east: lon + dLon };
}

// Coordinate pixel globali (tile 256) a zoom z
export const lon2px = (lon, z) => ((lon + 180) / 360) * 256 * 2 ** z;
export const lat2px = (lat, z) => {
  const s = Math.sin(toRad(lat));
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** z;
};
export const px2lon = (x, z) => (x / (256 * 2 ** z)) * 360 - 180;
export const px2lat = (y, z) => {
  const n = Math.PI - (2 * Math.PI * y) / (256 * 2 ** z);
  return toDeg(Math.atan(Math.sinh(n)));
};
export const metersPerPixel = (lat, z) => (156543.03392 * Math.cos(toRad(lat))) / 2 ** z;

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
export function aspectLabel(deg, slope) {
  if (slope != null && slope < 3) return 'Pianeggiante';
  return DIRS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

export function fmtCoord(v) { return v.toFixed(5); }

export const ASPECT_DEG = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SO: 225, O: 270, NO: 315 };
export const ASPECT_NAME = { N: 'Nord', NE: 'Nord-Est', E: 'Est', SE: 'Sud-Est', S: 'Sud', SO: 'Sud-Ovest', O: 'Ovest', NO: 'Nord-Ovest' };
export const angDiff = (a, b) => { const d = Math.abs((((a - b) % 360) + 360) % 360); return d > 180 ? 360 - d : d; };

// Direzione (gradi da Nord) per andare da a a b
export function bearing(a, b) {
  const f1 = toRad(a.lat), f2 = toRad(b.lat), dl = toRad(b.lon - a.lon);
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export const fmtDist = (km) => (km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(km < 10 ? 2 : 1).replace('.', ',')} km`);

// Coordinate da testo: decimali ("43.77, 11.25", "43,77 11,25") o gradi/primi/secondi ("43°46'16"N 11°15'20"E")
export function parseCoords(str) {
  const s = String(str || '').trim();
  if (!s) return null;
  let lat, lon;
  if (/[°'"′″]/.test(s)) {
    const parts = [...s.matchAll(/(-?\d+(?:[.,]\d+)?)\s*°\s*(?:(\d+(?:[.,]\d+)?)\s*['′]\s*)?(?:(\d+(?:[.,]\d+)?)\s*["″]\s*)?([NSEWO])?/gi)];
    if (parts.length < 2) return null;
    const val = (m) => {
      const n = (x) => (x ? Number(x.replace(',', '.')) : 0);
      let v = Math.abs(n(m[1])) + n(m[2]) / 60 + n(m[3]) / 3600;
      if (m[1].startsWith('-') || /[SWO]/i.test(m[4] || '')) v = -v;
      return v;
    };
    [lat, lon] = [val(parts[0]), val(parts[1])];
    if (/[EWO]/i.test(parts[0][4] || '') && /[NS]/i.test(parts[1][4] || '')) [lat, lon] = [lon, lat];
  } else {
    const nums = s.match(/-?\d+(?:[.,]\d+)?/g);
    if (!nums || nums.length !== 2) return null;
    [lat, lon] = nums.map((x) => Number(x.replace(',', '.')));
  }
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

export function pointInPolygon(lon, lat, rings) {
  // rings: array di anelli [[lon,lat],...]; regola pari/dispari
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
