// Show photo, darkness and ink mask side by side for a page region.
import fs from "node:fs";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { detectPage, warpPage } from "../src/page.js";
import { extractStrokes } from "../src/extract.js";
const [file, fx0, fy0, fx1, fy1] = process.argv.slice(2);
const img = jpeg.decode(fs.readFileSync(file), { useTArray: true });
const page = warpPage(img, detectPage(img), { maxWidth: 1800 });
const { width: W, height: H } = page;
const x0 = Math.round(fx0 * W), y0 = Math.round(fy0 * H), w = Math.round((fx1 - fx0) * W), h = Math.round((fy1 - fy0) * H);
let ink, dark;
const strokes = extractStrokes(page, { inkOut: (i, d) => { ink = Uint8Array.from(i); dark = Float32Array.from(d); } });
const out = new PNG({ width: w * 3, height: h });
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const p = (y0 + y) * W + x0 + x;
  const put = (k, r, g, b) => { const o = (y * w * 3 + k * w + x) * 4; out.data[o] = r; out.data[o + 1] = g; out.data[o + 2] = b; out.data[o + 3] = 255; };
  put(0, page.data[p * 4], page.data[p * 4 + 1], page.data[p * 4 + 2]);
  const v = 255 - Math.min(255, dark[p] * 3 * 255); put(1, v, v, v);
  put(2, ink[p] ? 0 : 255, ink[p] ? 0 : 255, ink[p] ? 0 : 255);
}
// mark stroke points in red on the ink panel
for (const s of strokes) for (const [x, y] of s.points) {
  const X = Math.round(x - 0.5) - x0, Y = Math.round(y - 0.5) - y0;
  if (X >= 0 && Y >= 0 && X < w && Y < h) { const o = (Y * w * 3 + 2 * w + X) * 4; out.data[o] = 255; out.data[o + 1] = 0; out.data[o + 2] = 0; }
}
fs.writeFileSync("out/ink-debug.png", PNG.sync.write(out));
console.log("crop", w, h);
