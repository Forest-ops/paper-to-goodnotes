// Make a clean render look like a phone photo: uneven light, grey ink, blur, grain.
export function degrade(src, w, h) {
  // deterministic noise
  let seed = 42;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = src[i * 4] / 255;
  // box blur radius 1 (soft focus)
  const b = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const X = x + dx, Y = y + dy;
      if (X >= 0 && Y >= 0 && X < w && Y < h) { s += g[Y * w + X]; n++; }
    }
    b[y * w + x] = s / n;
  }
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const light = 0.62 + 0.3 * (x / w) + 0.08 * Math.sin(y / 60); // shadow on the left
    const paper = light, inkTone = 0.22 * light;                    // grey-blue ballpoint
    let v = inkTone + (paper - inkTone) * b[i] + (rnd() - 0.5) * 0.08;
    v = Math.min(1, Math.max(0, v));
    out[i * 4] = v * 235; out[i * 4 + 1] = v * 240; out[i * 4 + 2] = Math.min(255, v * 255 + 10); out[i * 4 + 3] = 255;
  }
  return out;
}
