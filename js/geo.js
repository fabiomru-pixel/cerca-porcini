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
