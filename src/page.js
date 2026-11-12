// Find the sheet of paper in a photo and straighten it into a flat, cropped page image.
//
//   const quad = detectPage(img);            // 4 corners [TL, TR, BR, BL] or null
//   const page = warpPage(img, quad);        // { data, width, height } RGBA, page only
//
// Paper is the largest bright region. Its corners come from the extreme points of x+y and
// x-y, which is reliable for pages turned up to about 30 degrees and shot at an angle.

export function detectPage(img, { inset = 0.003 } = {}) {
  const { width: W, height: H, data } = img;
  const s = Math.min(1, 900 / Math.max(W, H));
  const w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(H * s));
  // downscale (box average) to grey
  const g = new Float32Array(w * h);
  const cnt = new Float32Array(w * h);
  for (let y = 0; y < H; y++) {
    const yy = Math.min(h - 1, Math.floor(y * s));
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const k = yy * w + Math.min(w - 1, Math.floor(x * s));
      g[k] += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      cnt[k]++;
    }
  }
  for (let k = 0; k < g.length; k++) g[k] /= cnt[k] || 1;
  const t = otsu(g);
  // light 3x3 smoothing of the mask decision, then largest bright 4-connected component
  const bright = new Uint8Array(w * h);
  for (let k = 0; k < g.length; k++) bright[k] = g[k] > t ? 1 : 0;
  const label = new Int32Array(w * h).fill(-1);
  let best = null;
  const stack = [];
  for (let k = 0; k < bright.length; k++) {
    if (!bright[k] || label[k] >= 0) continue;
    const comp = [];
    stack.push(k); label[k] = k;
    let touchL = false, touchR = false, touchT = false, touchB = false;
    while (stack.length) {
      const p = stack.pop();
      comp.push(p);
      const x = p % w, y = (p - x) / w;
      if (x === 0) touchL = true; if (x === w - 1) touchR = true;
      if (y === 0) touchT = true; if (y === h - 1) touchB = true;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q >= 0 && bright[q] && label[q] < 0) { label[q] = k; stack.push(q); }
      }
    }
    if (!best || comp.length > best.comp.length) best = { comp, touches: touchL + touchR + touchT + touchB };
  }
  if (!best) return null;
  const grown = growSmooth(best.comp, g, w, h, t);
  if (grown) best = grown;
  const frac = best.comp.length / (w * h);
  // page fills the frame (or nothing page-like found): use the whole photo
  if (frac < 0.08 || best.touches >= 3) return null;
  let tl, tr, br, bl;
  let mn1 = Infinity, mx1 = -Infinity, mn2 = Infinity, mx2 = -Infinity;
  let cx = 0, cy = 0;
  for (const p of best.comp) {
    const x = p % w, y = (p - x) / w;
    cx += x; cy += y;
    if (x + y < mn1) { mn1 = x + y; tl = [x, y]; }
    if (x + y > mx1) { mx1 = x + y; br = [x, y]; }
    if (x - y > mx2) { mx2 = x - y; tr = [x, y]; }
    if (x - y < mn2) { mn2 = x - y; bl = [x, y]; }
  }
  cx /= best.comp.length; cy /= best.comp.length;
  // Refine: fit a straight line to each edge of the sheet and intersect them. This finds
  // the true corners even when the paper has rounded corners.
  const fitted = fitEdges(best.comp, w, h, [tl, tr, br, bl]);
  if (fitted) [tl, tr, br, bl] = fitted;
  // back to full resolution (pixel centres), pulled slightly inward to skip the paper edge
  return [tl, tr, br, bl].map(([x, y]) => {
    const fx = (x + 0.5) / s, fy = (y + 0.5) / s;
    const ccx = (cx + 0.5) / s, ccy = (cy + 0.5) / s;
    return [fx + (ccx - fx) * inset * 2, fy + (ccy - fy) * inset * 2];
  });
}

// Part of a page in shadow can be darker than the global brightness threshold. Paper is
// smooth even in shadow while most backgrounds (carpet, wood grain, fabric) are textured,
// so grow from the bright part into connected pixels that are fairly bright AND smooth.
// Returns null (keep the bright region) if growing escapes into the background.
function growSmooth(seed, g, w, h, t) {
  // local standard deviation in a 5x5 window via integral images
  const S = new Float64Array((w + 1) * (h + 1)), S2 = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let r = 0, r2 = 0;
    for (let x = 0; x < w; x++) {
      const v = g[y * w + x];
      r += v; r2 += v * v;
      const k = (y + 1) * (w + 1) + x + 1;
      S[k] = S[k - w - 1] + r; S2[k] = S2[k - w - 1] + r2;
    }
  }
  const sd = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.max(0, x - 2), x1 = Math.min(w, x + 3), y0 = Math.max(0, y - 2), y1 = Math.min(h, y + 3);
    const n = (x1 - x0) * (y1 - y0);
    const a = y1 * (w + 1) + x1, b = y0 * (w + 1) + x1, c = y1 * (w + 1) + x0, d = y0 * (w + 1) + x0;
    const m = (S[a] - S[b] - S[c] + S[d]) / n;
    sd[y * w + x] = Math.sqrt(Math.max(0, (S2[a] - S2[b] - S2[c] + S2[d]) / n - m * m));
  }
  let paper = 0, bg = 0, nb = 0;
  for (const p of seed) paper += g[p];
  paper /= seed.length;
  for (let k = 0; k < g.length; k++) if (g[k] <= t) { bg += g[k]; nb++; }
  bg = nb ? bg / nb : 0;
  const tLow = bg + 0.35 * (paper - bg);
  const seedSd = [];
  for (let i = 0; i < seed.length; i += 7) seedSd.push(sd[seed[i]]);
  seedSd.sort((a, b) => a - b);
  const sdMax = Math.max(6, 2.5 * seedSd[seedSd.length >> 1] + 3);
  const inR = new Uint8Array(w * h);
  const comp = [...seed];
  for (const p of seed) inR[p] = 1;
  for (let i = 0; i < comp.length; i++) {
    const p = comp[i], x = p % w, y = (p - x) / w;
    for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
      if (q >= 0 && !inR[q] && g[q] > tLow && sd[q] < sdMax) { inR[q] = 1; comp.push(q); }
    }
  }
  if (comp.length === seed.length) return null;
  let tl = 0, tr = 0, tt = 0, tb = 0;
  for (const p of comp) {
    const x = p % w, y = (p - x) / w;
    if (x === 0) tl = 1; if (x === w - 1) tr = 1; if (y === 0) tt = 1; if (y === h - 1) tb = 1;
  }
  if (tl + tr + tt + tb >= 3 || comp.length > 0.97 * w * h) return null; // leaked into the background
  return { comp, touches: tl + tr + tt + tb };
}

// Outer boundary samples of the sheet: for each row its leftmost/rightmost pixel, for each
// column its topmost/bottommost. Each edge is fitted (trimming outliers such as binder
// holes or a thumb) away from the corners, then neighbouring edges are intersected.
function fitEdges(comp, w, h, [tl, tr, br, bl]) {
  const minX = new Int32Array(h).fill(w), maxX = new Int32Array(h).fill(-1);
  const minY = new Int32Array(w).fill(h), maxY = new Int32Array(w).fill(-1);
  for (const p of comp) {
    const x = p % w, y = (p - x) / w;
    if (x < minX[y]) minX[y] = x;
    if (x > maxX[y]) maxX[y] = x;
    if (y < minY[x]) minY[x] = y;
    if (y > maxY[x]) maxY[x] = y;
  }
  const span = (a, b) => { const lo = Math.min(a, b), hi = Math.max(a, b), m = (hi - lo) * 0.12; return [Math.ceil(lo + m), Math.floor(hi - m)]; };
  // fit u = a*v + b over samples [v, u]; two passes, dropping points far from the first fit
  const fit = (pts) => {
    if (pts.length < 8) return null;
    let use = pts;
    for (let pass = 0; pass < 3; pass++) {
      let sv = 0, su = 0, svv = 0, svu = 0;
      for (const [v, u] of use) { sv += v; su += u; svv += v * v; svu += v * u; }
      const n = use.length, den = n * svv - sv * sv;
      if (!den) return null;
      const a = (n * svu - sv * su) / den, b = (su - a * sv) / n;
      const res = pts.map(([v, u]) => Math.abs(u - (a * v + b)));
      const sorted = [...res].sort((x, y) => x - y);
      const tol = Math.max(1.5, 2.5 * sorted[sorted.length >> 1]);
      const next = pts.filter((_, i) => res[i] <= tol);
      if (pass === 2 || next.length < 8) return { a, b };
      use = next;
    }
  };
  const rows = (y0, y1, arr) => { const out = []; for (let y = y0; y <= y1; y++) if (arr[y] >= 0 && arr[y] < w) out.push([y, arr[y]]); return out; };
  const cols = (x0, x1, arr) => { const out = []; for (let x = x0; x <= x1; x++) if (arr[x] >= 0 && arr[x] < h) out.push([x, arr[x]]); return out; };
  const left = fit(rows(...span(tl[1], bl[1]), minX));   // x = a*y + b
  const right = fit(rows(...span(tr[1], br[1]), maxX));
  const top = fit(cols(...span(tl[0], tr[0]), minY));    // y = a*x + b
  const bottom = fit(cols(...span(bl[0], br[0]), maxY));
  if (!left || !right || !top || !bottom) return null;
  const meet = (vert, horiz) => { // x = va*y + vb, y = ha*x + hb
    const den = 1 - vert.a * horiz.a;
    if (Math.abs(den) < 1e-6) return null;
    const x = (vert.a * horiz.b + vert.b) / den;
    return [x, horiz.a * x + horiz.b];
  };
  const out = [meet(left, top), meet(right, top), meet(right, bottom), meet(left, bottom)];
  if (out.some((p) => !p)) return null;
  // sanity: the refined corners must stay near the rough ones
  const tolPx = 0.06 * Math.max(w, h);
  const rough = [tl, tr, br, bl];
  if (out.some((p, i) => Math.hypot(p[0] - rough[i][0], p[1] - rough[i][1]) > tolPx)) return null;
  return out;
}

function otsu(g) {
  const hist = new Float64Array(256);
  for (const v of g) hist[Math.max(0, Math.min(255, v | 0))]++;
  const total = g.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; t = i; }
  }
  return t;
}

// Perspective-correct the quad into an upright rectangle with the page's own aspect ratio.
export function warpPage(img, quad, { maxWidth = 2400, minWidth = 1200, upscale = 1.25 } = {}) {
  const [tl, tr, br, bl] = quad;
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const srcW = (d(tl, tr) + d(bl, br)) / 2;
  const srcH = (d(tl, bl) + d(tr, br)) / 2;
  const outW = Math.round(Math.min(maxWidth, Math.max(minWidth, srcW * upscale)));
  const outH = Math.round((outW * srcH) / srcW);
  const Hm = homography([[0, 0], [outW, 0], [outW, outH], [0, outH]], quad);
  const { width: W, height: H, data } = img;
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const X = x + 0.5, Y = y + 0.5;
      const zz = Hm[6] * X + Hm[7] * Y + 1;
      const sx = (Hm[0] * X + Hm[1] * Y + Hm[2]) / zz - 0.5;
      const sy = (Hm[3] * X + Hm[4] * Y + Hm[5]) / zz - 0.5;
      const x0 = Math.max(0, Math.min(W - 2, Math.floor(sx))), y0 = Math.max(0, Math.min(H - 2, Math.floor(sy)));
      const fx = Math.min(1, Math.max(0, sx - x0)), fy = Math.min(1, Math.max(0, sy - y0));
      const i00 = (y0 * W + x0) * 4, i10 = i00 + 4, i01 = i00 + W * 4, i11 = i01 + 4;
      const o = (y * outW + x) * 4;
      for (let c = 0; c < 3; c++) {
        out[o + c] = (data[i00 + c] * (1 - fx) + data[i10 + c] * fx) * (1 - fy) + (data[i01 + c] * (1 - fx) + data[i11 + c] * fx) * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { data: out, width: outW, height: outH };
}

// 3x3 homography (h33 = 1) mapping each src point to its dst point.
function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  return solve(A, b);
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}
