// Find the sheet of paper in a photo and straighten it into a flat, cropped page image.
//
//   const quad = detectPage(img);            // 4 corners [TL, TR, BR, BL] or null
//   const page = warpPage(img, quad);        // { data, width, height } RGBA, page only
//
// Paper is the largest bright region. Its corners come from the extreme points of x+y and
// x-y, which is reliable for pages turned up to about 30 degrees and shot at an angle.

export function detectPage(img, { inset = 0.012 } = {}) {
  const { width: W, height: H, data } = img;
  const s = Math.min(1, 480 / Math.max(W, H));
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
  // back to full resolution (pixel centres), pulled slightly inward to skip the paper edge
  return [tl, tr, br, bl].map(([x, y]) => {
    const fx = (x + 0.5) / s, fy = (y + 0.5) / s;
    const ccx = (cx + 0.5) / s, ccy = (cy + 0.5) / s;
    return [fx + (ccx - fx) * inset * 2, fy + (ccy - fy) * inset * 2];
  });
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
