// Curve di livello (marching squares) sul mosaico altimetrico, in coordinate lat/lon
export function contourLines(mosaic, level, { maxDim = 700, keep } = {}) {
  const k = Math.max(1, Math.ceil(Math.max(mosaic.W, mosaic.H) / maxDim));
  const W = Math.floor(mosaic.W / k), H = Math.floor(mosaic.H / k);
  const v = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) v[y * W + x] = mosaic.at(x * k, y * k);

  const segs = [];
  const lerp = (a, b) => (level - a) / (b - a || 1e-9);
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const a = v[y * W + x], b = v[y * W + x + 1], c = v[(y + 1) * W + x + 1], d = v[(y + 1) * W + x];
      if (a < -500 || b < -500 || c < -500 || d < -500) continue;
      const idx = (a >= level ? 8 : 0) | (b >= level ? 4 : 0) | (c >= level ? 2 : 0) | (d >= level ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      const top = [x + lerp(a, b), y], right = [x + 1, y + lerp(b, c)];
      const bottom = [x + lerp(d, c), y + 1], left = [x, y + lerp(a, d)];
      const add = (p, q) => segs.push([p, q]);
      switch (idx) {
        case 1: case 14: add(left, bottom); break;
        case 2: case 13: add(bottom, right); break;
        case 3: case 12: add(left, right); break;
        case 4: case 11: add(top, right); break;
        case 5: add(left, top); add(bottom, right); break;
        case 6: case 9: add(top, bottom); break;
        case 7: case 8: add(left, top); break;
        case 10: add(left, bottom); add(top, right); break;
      }
    }
  }
  // unisci i segmenti in polilinee
  const key = (p) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`;
  const ends = new Map();
  const lines = [];
  for (const [p, q] of segs) {
    const kp = key(p), kq = key(q);
    const lp = ends.get(kp), lq = ends.get(kq);
    if (lp && lq && lp !== lq) {
      ends.delete(kp); ends.delete(kq);
      if (key(lp[lp.length - 1]) !== kp) lp.reverse();
      if (key(lq[0]) !== kq) lq.reverse();
      lp.push(...lq);
      ends.set(key(lp[0]), lp); ends.set(key(lp[lp.length - 1]), lp);
      lq.length = 0;
    } else if (lp) {
      ends.delete(kp);
      if (key(lp[lp.length - 1]) === kp) lp.push(q); else lp.unshift(q);
      ends.set(kq, lp);
    } else if (lq) {
      ends.delete(kq);
      if (key(lq[lq.length - 1]) === kq) lq.push(p); else lq.unshift(p);
      ends.set(kp, lq);
    } else {
      const l = [p, q]; lines.push(l); ends.set(kp, l); ends.set(kq, l);
    }
  }
  const out = [];
  for (const l of lines) {
    if (l.length < 3) continue;
    let pts = l.map(([x, y]) => { const ll = mosaic.toLatLon(x * k, y * k); return [ll.lat, ll.lon]; });
    if (keep) {
      // spezza la linea tenendo solo i tratti che soddisfano il filtro
      let cur = [];
      for (const p of pts) {
        if (keep(p[0], p[1])) cur.push(p);
        else { if (cur.length > 2) out.push(cur); cur = []; }
      }
      if (cur.length > 2) out.push(cur);
    } else out.push(pts);
  }
  return out;
}
