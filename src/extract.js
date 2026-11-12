// Turn a photo of handwriting into pen strokes (centerlines with a half-width per point).
// Pure JS with no DOM, so it runs in the PWA (on canvas ImageData) and in Node tests.
//
//   const strokes = extractStrokes({ data, width, height });   // RGBA bytes
//   // -> [{ points: [[x, y, halfWidth], ...] }, ...] in pixel units

const DEFAULTS = {
  sensitivity: 0.5,   // 0..1; higher finds fainter ink (and more smudges)
  removeLines: true,  // subtract printed ruled lines
  removeBlobs: true,  // ignore large solid dark areas (binder holes, shadows, fills)
  minComponentArea: 0, // drop specks smaller than this (0 = auto)
  spurFactor: 1.5,    // prune skeleton branches shorter than this x stroke width
  joinAngleDeg: 40,   // continue straight through a junction if the bend is under this
  simplifyEps: 0.7,   // polyline simplification tolerance in px
};

export function extractStrokes(img, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const { width: w, height: h } = img;
  const gray = toGray(img);
  const dark = darkness(gray, w, h);
  const blobs = o.removeBlobs ? maskBlobs(dark, w, h, typicalStrokeHalf(hysteresis(dark, w, h, o.sensitivity), w, h)) : null;
  let lineBands = [];
  if (o.removeLines) {
    lineBands = removeRuledLines(dark, w, h);
    if (o.stats) o.stats.ruledLines = lineBands.length;
  }
  if (o.darkOut) o.darkOut(dark);
  const ink = hysteresis(dark, w, h, o.sensitivity);
  removeSpecks(ink, w, h, o.minComponentArea || Math.max(8, Math.round((w * h) / 2e5)));
  const dist = distanceTransform(ink, w, h);
  const skel = thin(ink, w, h);
  const graph = buildGraph(skel, w, h);
  const typicalHalf = Math.sqrt(median(graph.edges.flatMap((e) => e.px.map((p) => dist[p])))) || 1;
  pruneSpurs(graph, typicalHalf * 2 * o.spurFactor);
  if (o.debug) o.debug(graph, typicalHalf);
  const chains = joinAtJunctions(graph, w, o.joinAngleDeg);
  const strokes = [];
  for (const chain of chains) {
    let pts = chain.map((p) => [p % w + 0.5, Math.floor(p / w) + 0.5, Math.sqrt(dist[p])]);
    if (pts.length < 2) continue;
    pts = clampWidths(pts);
    pts = smooth(pts, 2);
    pts = simplify(pts, o.simplifyEps);
    if (length(pts) < Math.max(3, 2 * typicalHalf)) continue; // speck
    if (onRuledLine(pts, lineBands, typicalHalf)) continue;  // leftover piece of a printed line
    if (blobs && length(pts) < 8 * typicalHalf) {            // crumb at the rim of a hole
      const lim = (blobs.reach + 6 * typicalHalf) ** 2;
      if (pts.some(([x, y]) => blobs.toCore[Math.min(h - 1, y | 0) * w + Math.min(w - 1, x | 0)] <= lim)) continue;
    }
    strokes.push({ points: pts });
  }
  if (o.stats) o.stats.typicalHalfWidth = +typicalHalf.toFixed(2);
  return strokes;
}

// ------------------------------------------------------------------ pixels

export function toGray({ data, width, height }) {
  const g = new Float32Array(width * height);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    g[i] = (0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]) / 255;
  }
  return g;
}

// How much darker each pixel is than the paper around it (0 = paper, 1 = black).
// Paper brightness is the 90th percentile of each block, smoothed and interpolated,
// which evens out shadows and lighting gradients across the page.
export function darkness(gray, w, h) {
  const B = Math.max(16, Math.round(Math.min(w, h) / 30));
  const bw = Math.ceil(w / B), bh = Math.ceil(h / B);
  let grid = new Float32Array(bw * bh);
  const buf = [];
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      buf.length = 0;
      for (let y = by * B; y < Math.min(h, (by + 1) * B); y++)
        for (let x = bx * B; x < Math.min(w, (bx + 1) * B); x++) buf.push(gray[y * w + x]);
      buf.sort((a, b) => a - b);
      grid[by * bw + bx] = buf[Math.floor(buf.length * 0.9)];
    }
  }
  // 3x3 max (blocks covered by ink borrow paper from neighbours), then 3x3 mean
  const pass = (src, fn) => {
    const out = new Float32Array(src.length);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const vals = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy;
        if (X >= 0 && Y >= 0 && X < bw && Y < bh) vals.push(src[Y * bw + X]);
      }
      out[y * bw + x] = fn(vals);
    }
    return out;
  };
  grid = pass(grid, (v) => Math.max(...v));
  grid = pass(grid, (v) => v.reduce((a, b) => a + b, 0) / v.length);
  const d = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(bh - 1, Math.max(0, (y + 0.5) / B - 0.5));
    const y0 = Math.floor(gy), y1 = Math.min(bh - 1, y0 + 1), fy = gy - y0;
    for (let x = 0; x < w; x++) {
      const gx = Math.min(bw - 1, Math.max(0, (x + 0.5) / B - 0.5));
      const x0 = Math.floor(gx), x1 = Math.min(bw - 1, x0 + 1), fx = gx - x0;
      const bg = (grid[y0 * bw + x0] * (1 - fx) + grid[y0 * bw + x1] * fx) * (1 - fy) +
        (grid[y1 * bw + x0] * (1 - fx) + grid[y1 * bw + x1] * fx) * fy;
      d[y * w + x] = Math.min(1, Math.max(0, 1 - gray[y * w + x] / Math.max(bg, 0.05)));
    }
  }
  // the outermost sliver is usually the paper's edge or what is beyond it
  const m = Math.max(2, Math.round(Math.min(w, h) * 0.006));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
    if (x < m || y < m || x >= w - m || y >= h - m) d[y * w + x] = 0;
  return d;
}

// Printed ruled lines show up as rows that are slightly darker across the whole page.
// For those rows, subtract the line's own darkness (a horizontal opening, which ignores
// pen strokes crossing it), capped near the line's typical level so that ink drawn right
// on top of a line survives. Returns the row bands of the lines removed.
function removeRuledLines(d, w, h) {
  const x0 = Math.floor(w * 0.08), x1 = Math.ceil(w * 0.92);
  const prof = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = x0; x < x1; x++) s += Math.min(d[y * w + x], 0.15);
    prof[y] = s / (x1 - x0);
  }
  const R = Math.max(6, Math.round(h / 150));
  const peak = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    const win = Array.from(prof.subarray(Math.max(0, y - R), Math.min(h, y + R + 1))).sort((a, b) => a - b);
    peak[y] = prof[y] - win[win.length >> 1];
  }
  const mad = median(Array.from(peak, Math.abs));
  const thr = Math.max(0.004, 6 * mad);
  const bands = [];
  for (let y = 0; y < h; y++) {
    if (peak[y] <= thr) continue;
    const last = bands[bands.length - 1];
    if (last && y - last[1] <= 2) last[1] = y; else bands.push([y, y]);
  }
  const L = Math.max(15, Math.round(w / 40)) | 1, r = L >> 1;
  const tmp = new Float32Array(w), op = new Float32Array(w), ref = new Float32Array(w);
  const bandOpen = (ya, yb, out) => { // per column max over rows ya..yb, then opened along x
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let y = Math.max(0, ya); y <= Math.min(h - 1, yb); y++) m = Math.max(m, d[y * w + x]);
      op[x] = m;
    }
    openRow(op, out, r);
  };
  const removed = [];
  for (const [b0, b1] of bands) {
    if (b1 - b0 > Math.max(8, h / 200)) continue; // too thick to be a printed line
    // a printed line runs across most of the page; a long pen stroke does not.
    // Opening (min then max along x) of the band's darkness removes grain spikes first.
    let pk = b0;
    for (let y = b0; y <= b1; y++) if (peak[y] > peak[pk]) pk = y;
    // compare against an equally thick strip of paper just above (or below) the band
    const t = b1 - b0 + 2;
    const refA = b0 - 3 - t >= 0 ? b0 - 3 - t : b1 + 3;
    bandOpen(b0 - 1, b1 + 1, tmp);
    bandOpen(refA, refA + t, ref);
    let covered = 0;
    for (let x = x0; x < x1; x++) if (tmp[x] - ref[x] >= 0.5 * peak[pk] && tmp[x] <= 0.3) covered++;
    if (covered < 0.55 * (x1 - x0)) continue;
    removed.push([b0, b1]);
    for (let y = Math.max(0, b0 - 1); y <= Math.min(h - 1, b1 + 1); y++) {
      const row = d.subarray(y * w, y * w + w);
      openRow(row, op, r, tmp);
      const cap = median(Array.from(op.subarray(x0, x1))) * 2.5 + 0.015;
      for (let x = 0; x < w; x++) row[x] = Math.max(0, row[x] - Math.min(op[x], cap));
    }
  }
  return removed;
}

// Typical stroke half-width in px: the median distance-transform value on stroke ridges
// (one ridge pixel per pixel of stroke length, so big blobs barely count).
function typicalStrokeHalf(ink, w, h) {
  const dist = distanceTransform(ink, w, h);
  const ridge = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = y * w + x, v = dist[p];
    if (!v) continue;
    let top = true;
    forNeighbors(p, w, h, (q) => { if (dist[q] > v) top = false; });
    if (top) ridge.push(Math.sqrt(v));
  }
  return median(ridge) || 1;
}

// Morphological opening along a row: out[x] = max over window of (min over window).
// Keeps features at least 2r+1 long (printed lines), drops shorter ones (pen crossings).
function openRow(src, out, r, scratch = new Float32Array(src.length)) {
  const n = src.length;
  for (let x = 0; x < n; x++) {
    let m = Infinity;
    for (let k = Math.max(0, x - r); k <= Math.min(n - 1, x + r); k++) if (src[k] < m) m = src[k];
    scratch[x] = m;
  }
  for (let x = 0; x < n; x++) {
    let m = -Infinity;
    for (let k = Math.max(0, x - r); k <= Math.min(n - 1, x + r); k++) if (scratch[k] > m) m = scratch[k];
    out[x] = m;
  }
}

// Zero out big solid dark regions: binder holes, the table showing through, deep shadows.
// Anything several times thicker than this photo's typical stroke is not writing.
function maskBlobs(d, w, h, half) {
  const r = Math.max(4, Math.round(3.5 * half));
  const m = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    let s = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += d[(y + dy) * w + x + dx];
    m[y * w + x] = s / 9 > 0.22 ? 1 : 0;
  }
  const dist = distanceTransform(m, w, h);
  const notCore = new Uint8Array(w * h);
  let any = false;
  for (let i = 0; i < m.length; i++) { const core = dist[i] > r * r; notCore[i] = core ? 0 : 1; any ||= core; }
  if (!any) return null;
  const toCore = distanceTransform(notCore, w, h); // squared distance to the nearest core
  const grow = (r + 8) * (r + 8);
  for (let i = 0; i < d.length; i++) if (toCore[i] <= grow) d[i] = 0;
  return { toCore, reach: r + 8 };
}

// Two-level threshold: strong ink starts a stroke, fainter ink connected to it extends it.
// Faint pencil survives as long as part of it is clearly visible; isolated grain does not.
function hysteresis(raw, w, h, sensitivity) {
  // 3x3 box blur: grain averages out, real strokes (2+ px wide) keep most of their darkness
  const d = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    let t = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) t += raw[(y + dy) * w + x + dx];
    d[y * w + x] = t / 9;
  }
  // noise floor of this photo: median and spread of the (mostly paper) darkness values
  const sample = [];
  for (let i = 0; i < d.length; i += 7) sample.push(d[i]);
  sample.sort((a, b) => a - b);
  const med = sample[sample.length >> 1];
  const mad = median(sample.map((v) => Math.abs(v - med))) * 1.4826;
  const s = Math.min(1, Math.max(0, sensitivity));
  const lo = Math.max(0.07 - 0.05 * s, med + (6 - 3 * s) * mad); // base 0.07 .. 0.02
  const hi = Math.max(lo * 2, med + (10 - 4 * s) * mad);
  const ink = new Uint8Array(w * h);
  const stack = [];
  for (let i = 0; i < d.length; i++) {
    if (d[i] <= hi || ink[i]) continue;
    ink[i] = 1; stack.push(i);
    while (stack.length) {
      const p = stack.pop();
      forNeighbors(p, w, h, (q) => { if (!ink[q] && d[q] > lo) { ink[q] = 1; stack.push(q); } });
    }
  }
  return ink;
}

function removeSpecks(ink, w, h, minArea) {
  const seen = new Uint8Array(w * h);
  const stack = [];
  for (let s = 0; s < ink.length; s++) {
    if (!ink[s] || seen[s]) continue;
    const comp = [];
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const p = stack.pop();
      comp.push(p);
      forNeighbors(p, w, h, (q) => { if (ink[q] && !seen[q]) { seen[q] = 1; stack.push(q); } });
    }
    if (comp.length < minArea) for (const p of comp) ink[p] = 0;
  }
}

// Squared Euclidean distance from each ink pixel to the nearest background pixel
// (Felzenszwalb & Huttenlocher). sqrt of it at a centerline pixel ~ stroke half-width.
function distanceTransform(ink, w, h) {
  const INF = 1e20;
  const f = new Float64Array(Math.max(w, h));
  const d = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h));
  const z = new Float64Array(Math.max(w, h) + 1);
  const out = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = ink[i] ? INF : 0;
  const pass = (n, get, set) => {
    for (let i = 0; i < n; i++) f[i] = get(i);
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s;
      while (true) {
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        if (s <= z[k]) k--; else break;
      }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
    for (let i = 0; i < n; i++) set(i, d[i]);
  };
  for (let x = 0; x < w; x++) pass(h, (i) => out[i * w + x], (i, val) => { out[i * w + x] = val; });
  for (let y = 0; y < h; y++) pass(w, (i) => out[y * w + i], (i, val) => { out[y * w + i] = val; });
  return out;
}

// Zhang-Suen thinning to a 1-px skeleton.
function thin(ink, w, h) {
  const img = Uint8Array.from(ink);
  for (let x = 0; x < w; x++) { img[x] = 0; img[(h - 1) * w + x] = 0; }
  for (let y = 0; y < h; y++) { img[y * w] = 0; img[y * w + w - 1] = 0; }
  const del = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      del.length = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const p = y * w + x;
          if (!img[p]) continue;
          const n = ring(img, p, w);
          let B = 0, A = 0;
          for (let i = 0; i < 8; i++) { B += n[i]; if (!n[i] && n[(i + 1) % 8]) A++; }
          if (B < 2 || B > 6 || A !== 1) continue;
          // n: [N, NE, E, SE, S, SW, W, NW]
          if (step === 0 ? (n[0] * n[2] * n[4] || n[2] * n[4] * n[6]) : (n[0] * n[2] * n[6] || n[0] * n[4] * n[6])) continue;
          del.push(p);
        }
      }
      for (const p of del) img[p] = 0;
      if (del.length) changed = true;
    }
  }
  // remove staircase corners so every interior centerline pixel has exactly 2 neighbours
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if (!img[p]) continue;
      const n = ring(img, p, w);
      for (let i = 0; i < 8; i += 2) {
        // an orthogonal pair like N+E with the diagonal NE empty and both other sides empty
        const a = n[i], b = n[(i + 2) % 8], opp1 = n[(i + 4) % 8], opp2 = n[(i + 6) % 8], diagOpp = n[(i + 5) % 8];
        if (a && b && !opp1 && !opp2 && !diagOpp) { img[p] = 0; break; }
      }
    }
  }
  return img;
}

const DX = [0, 1, 1, 1, 0, -1, -1, -1];
const DY = [-1, -1, 0, 1, 1, 1, 0, -1];

function ring(img, p, w) {
  const out = new Array(8);
  for (let i = 0; i < 8; i++) out[i] = img[p + DY[i] * w + DX[i]] ? 1 : 0;
  return out;
}

function forNeighbors(p, w, h, fn) {
  const x = p % w, y = (p - x) / w;
  for (let i = 0; i < 8; i++) {
    const nx = x + DX[i], ny = y + DY[i];
    if (nx >= 0 && ny >= 0 && nx < w && ny < h) fn(ny * w + nx);
  }
}

// ------------------------------------------------------------------ skeleton graph

// Nodes are endpoints (1 neighbour) and junction clusters (3+ neighbours).
// Edges are the pixel runs between them. Closed loops with no node get a synthetic node.
function buildGraph(skel, w, h) {
  const deg = new Uint8Array(w * h);
  const pixels = [];
  for (let p = 0; p < skel.length; p++) {
    if (!skel[p]) continue;
    pixels.push(p);
    let n = 0;
    forNeighbors(p, w, h, (q) => { n += skel[q]; });
    deg[p] = n;
  }
  const nodeOf = new Int32Array(w * h).fill(-1);
  const nodes = [];
  for (const p of pixels) {
    if (nodeOf[p] >= 0 || deg[p] === 2) continue;
    const id = nodes.length;
    const members = [];
    const stack = [p];
    nodeOf[p] = id;
    while (stack.length) { // cluster touching junction pixels into one node
      const q = stack.pop();
      members.push(q);
      if (deg[q] < 3) continue;
      forNeighbors(q, w, h, (r) => {
        if (skel[r] && deg[r] >= 3 && nodeOf[r] < 0) { nodeOf[r] = id; stack.push(r); }
      });
    }
    nodes.push({ id, members, edges: [] });
  }
  const edges = [];
  const used = new Uint8Array(w * h); // pixel already in an edge (non-node pixels)
  const walk = (startNode, from, first) => {
    const px = [from, first];
    let prev = from, cur = first;
    while (nodeOf[cur] < 0) {
      used[cur] = 1;
      let next = -1;
      forNeighbors(cur, w, h, (q) => {
        if (next >= 0 || q === prev || !skel[q]) return;
        if (nodeOf[q] >= 0 && nodeOf[q] !== startNode.id) { next = q; return; }
        if (nodeOf[q] >= 0 && px.length > 3) { next = q; return; } // loop back to start
        if (nodeOf[q] < 0 && !used[q]) next = q;
      });
      if (next < 0) break;
      prev = cur; cur = next; px.push(cur);
    }
    const end = nodeOf[cur] >= 0 ? nodes[nodeOf[cur]] : null;
    const e = { id: edges.length, a: startNode.id, b: end ? end.id : -1, px, alive: true };
    edges.push(e);
    startNode.edges.push(e.id);
    if (end && end !== startNode) end.edges.push(e.id);
    else if (end) startNode.edges.push(e.id);
  };
  for (const node of nodes) {
    for (const m of node.members) {
      forNeighbors(m, w, h, (q) => {
        if (!skel[q] || used[q]) return;
        if (nodeOf[q] < 0) walk(node, m, q);
        else if (nodeOf[q] !== node.id && node.id < nodeOf[q] && !nodes[node.id].edges.some((eid) => {
          const e = edges[eid]; return (e.a === nodeOf[q] || e.b === nodeOf[q]) && e.px.length === 2;
        })) {
          // two nodes directly adjacent
          const e = { id: edges.length, a: node.id, b: nodeOf[q], px: [m, q], alive: true };
          edges.push(e); node.edges.push(e.id); nodes[nodeOf[q]].edges.push(e.id);
        }
      });
    }
  }
  // closed loops (like an "o") that never touched a node
  for (const p of pixels) {
    if (used[p] || nodeOf[p] >= 0) continue;
    const id = nodes.length;
    nodeOf[p] = id;
    const node = { id, members: [p], edges: [] };
    nodes.push(node);
    let first = -1;
    forNeighbors(p, w, h, (q) => { if (first < 0 && skel[q] && !used[q] && q !== p) first = q; });
    if (first >= 0) walk(node, p, first);
  }
  return { nodes, edges, w };
}

function pruneSpurs(graph, minLen) {
  // Tiny holes in the ink (common at sharp turns and where a pen retraces) turn into small
  // skeleton loops: two parallel short edges between the same nodes, or a short self-loop.
  // Keep only the shortest edge of each such group.
  const groups = new Map();
  for (const e of graph.edges) {
    if (!e.alive || e.b < 0) continue;
    if (e.a === e.b) { if (e.px.length < 2 * minLen) e.alive = false; continue; }
    const key = e.a < e.b ? `${e.a}-${e.b}` : `${e.b}-${e.a}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((x, y) => x.px.length - y.px.length);
    for (const e of g.slice(1)) if (e.px.length < 2 * minLen) e.alive = false;
  }
  // then repeatedly drop short branches that dead-end, which thinning leaves on blobs and corners
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of graph.nodes) {
      const alive = n.edges.filter((id) => graph.edges[id].alive);
      if (alive.length !== 1) continue;
      const e = graph.edges[alive[0]];
      const other = graph.nodes[e.a === n.id ? e.b : e.a];
      if (!other) continue;
      const otherDeg = other.edges.filter((id) => graph.edges[id].alive).length;
      if (otherDeg >= 3 && e.px.length < minLen) { e.alive = false; changed = true; }
    }
  }
}

// Link edges into strokes: at each junction, pair up the edges that continue most
// straight (e.g. the two halves of a crossed "t"), and end the others there.
function joinAtJunctions(graph, w, maxBendDeg) {
  const { nodes, edges } = graph;
  const link = new Map(); // `${edgeId}:${end}` -> [otherEdgeId, otherEnd]
  const cosLimit = Math.cos(((180 - maxBendDeg) * Math.PI) / 180);
  const dirAt = (e, end) => { // unit vector pointing away from the node, along the edge
    const px = end === 0 ? e.px : [...e.px].reverse();
    const k = Math.min(px.length - 1, 10);
    const ax = px[0] % w, ay = Math.floor(px[0] / w), bx = px[k] % w, by = Math.floor(px[k] / w);
    const L = Math.hypot(bx - ax, by - ay) || 1;
    return [(bx - ax) / L, (by - ay) / L];
  };
  for (const n of nodes) {
    const ends = [];
    for (const id of n.edges) {
      const e = edges[id];
      if (!e.alive) continue;
      if (e.a === n.id) ends.push([id, 0]);
      if (e.b === n.id && !(e.a === n.id && ends.some(([i, s]) => i === id && s === 1))) ends.push([id, 1]);
    }
    if (ends.length < 2) continue;
    const pairs = [];
    for (let i = 0; i < ends.length; i++) {
      for (let j = i + 1; j < ends.length; j++) {
        const [ea, sa] = ends[i], [eb, sb] = ends[j];
        if (ea === eb && sa === sb) continue;
        const da = dirAt(edges[ea], sa), db = dirAt(edges[eb], sb);
        const c = da[0] * db[0] + da[1] * db[1]; // -1 = perfectly straight through
        pairs.push([c, i, j]);
      }
    }
    pairs.sort((a, b) => a[0] - b[0]);
    const taken = new Set();
    const pass = ends.length === 2; // a plain 2-way node always continues
    for (const [c, i, j] of pairs) {
      if (taken.has(i) || taken.has(j)) continue;
      if (!pass && c > cosLimit) break;
      taken.add(i); taken.add(j);
      link.set(`${ends[i][0]}:${ends[i][1]}`, ends[j]);
      link.set(`${ends[j][0]}:${ends[j][1]}`, ends[i]);
    }
  }
  const done = new Set();
  const chains = [];
  const follow = (startId, startEnd) => {
    // walk from edge startId entering at end startEnd, across links
    const out = [];
    let id = startId, end = startEnd;
    while (id !== undefined && !done.has(id)) {
      done.add(id);
      const px = end === 0 ? edges[id].px : [...edges[id].px].reverse();
      out.push(...(out.length ? px.slice(1) : px));
      const nxt = link.get(`${id}:${1 - end}`);
      if (!nxt) break;
      [id, end] = nxt;
    }
    return out;
  };
  // start chains at free ends first, then whatever is left (closed loops)
  for (const e of edges) {
    if (!e.alive || done.has(e.id)) continue;
    for (const end of [0, 1]) {
      if (!link.has(`${e.id}:${end}`) && !done.has(e.id)) chains.push(follow(e.id, end));
    }
  }
  for (const e of edges) if (e.alive && !done.has(e.id)) chains.push(follow(e.id, 0));
  return chains.filter((c) => c.length >= 2);
}

// ------------------------------------------------------------------ polylines

function length(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

// A flat, nearly horizontal stroke sitting inside a ruled-line band is what is left of the
// printed line, not writing.
function onRuledLine(pts, bands, half) {
  if (!bands.length) return false;
  let y0 = Infinity, y1 = -Infinity;
  for (const p of pts) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  if (y1 - y0 > Math.max(4, 2.5 * half)) return false;
  const m = Math.max(3, 1.5 * half);
  return bands.some(([b0, b1]) => y0 >= b0 - m && y1 <= b1 + m);
}

function median(a) {
  if (!a.length) return 0;
  const s = Float64Array.from(a).sort();
  return s[s.length >> 1];
}

// Distance-transform widths balloon where strokes cross; cap them near the stroke's median.
function clampWidths(pts) {
  const m = median(pts.map((p) => p[2]));
  return pts.map(([x, y, r]) => [x, y, Math.min(Math.max(r, 0.5), m * 1.4)]);
}

function smooth(pts, passes) {
  let p = pts;
  for (let k = 0; k < passes; k++) {
    p = p.map((q, i) => {
      if (i === 0 || i === p.length - 1) return q;
      const a = p[i - 1], b = p[i + 1];
      return [(a[0] + 2 * q[0] + b[0]) / 4, (a[1] + 2 * q[1] + b[1]) / 4, (a[2] + 2 * q[2] + b[2]) / 4];
    });
  }
  return p;
}

// Ramer-Douglas-Peucker on x,y.
function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    const [ax, ay] = pts[i], [bx, by] = pts[j];
    const L = Math.hypot(bx - ax, by - ay) || 1e-9;
    let best = -1, bi = -1;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs((bx - ax) * (ay - pts[k][1]) - (ax - pts[k][0]) * (by - ay)) / L;
      if (d > best) { best = d; bi = k; }
    }
    if (best > eps) { keep[bi] = 1; stack.push([i, bi], [bi, j]); }
  }
  return pts.filter((_, k) => keep[k]);
}
