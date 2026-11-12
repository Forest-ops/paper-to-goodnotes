// Turn a photo of handwriting into pen strokes (centerlines with a half-width per point).
// Pure JS with no DOM, so it runs in the PWA (on canvas ImageData) and in Node tests.
//
//   const strokes = extractStrokes({ data, width, height });   // RGBA bytes
//   // -> [{ points: [[x, y, halfWidth], ...] }, ...] in pixel units

const DEFAULTS = {
  window: 0,          // adaptive-threshold window in px (0 = auto from image size)
  sauvolaK: 0.2,      // threshold sensitivity; higher = less ink
  minInkContrast: 0.08, // ink must be this much darker than its surroundings
  minComponentArea: 0, // drop specks smaller than this (0 = auto)
  spurFactor: 1.5,    // prune skeleton branches shorter than this x stroke width
  joinAngleDeg: 40,   // continue straight through a junction if the bend is under this
  simplifyEps: 0.7,   // polyline simplification tolerance in px
};

export function extractStrokes(img, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const { width: w, height: h } = img;
  const gray = toGray(img);
  const ink = binarize(gray, w, h, o);
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
    strokes.push({ points: pts });
  }
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

// Sauvola adaptive threshold: copes with uneven lighting and paper shadows in photos.
function binarize(gray, w, h, o) {
  const win = o.window || Math.max(15, Math.round(Math.min(w, h) / 20) | 1);
  const r = win >> 1;
  const S = new Float64Array((w + 1) * (h + 1));
  const S2 = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0, row2 = 0;
    for (let x = 0; x < w; x++) {
      const v = gray[y * w + x];
      row += v; row2 += v * v;
      const k = (y + 1) * (w + 1) + x + 1;
      S[k] = S[k - w - 1] + row;
      S2[k] = S2[k - w - 1] + row2;
    }
  }
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const n = (x1 - x0) * (y1 - y0);
      const a = y1 * (w + 1) + x1, b = y0 * (w + 1) + x1, c = y1 * (w + 1) + x0, d = y0 * (w + 1) + x0;
      const mean = (S[a] - S[b] - S[c] + S[d]) / n;
      const sd = Math.sqrt(Math.max(0, (S2[a] - S2[b] - S2[c] + S2[d]) / n - mean * mean));
      const t = mean * (1 + o.sauvolaK * (sd / 0.5 - 1));
      const v = gray[y * w + x];
      ink[y * w + x] = v < t && v < mean - o.minInkContrast ? 1 : 0;
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
