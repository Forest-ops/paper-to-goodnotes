// Run extraction on a rendered note whose true strokes are known, and score it.
//   node test/extract-test.mjs [--photo]
// --photo degrades the image first (uneven lighting, grey ink, blur, noise) to mimic a camera shot.
// Writes out/extract-<variant>.svg: the image with extracted strokes drawn over it.
import fs from "node:fs";
import { PNG } from "pngjs";
import { extractStrokes } from "../src/extract.js";
import { degrade } from "./degrade.mjs";

const photo = process.argv.includes("--photo");
const dir = "samples/synthetic";
const truth = JSON.parse(fs.readFileSync(`${dir}/testing.truth.json`, "utf8"));
const png = PNG.sync.read(fs.readFileSync(`${dir}/testing.png`));
const { width: w, height: h } = png;
let data = png.data;

if (photo) data = degrade(data, w, h);

const t0 = performance.now();
const strokes = extractStrokes({ data, width: w, height: h });
const ms = performance.now() - t0;

// true centerlines in pixel space
const toPx = ([x, y, r]) => [(x - truth.origin[0]) * truth.scale, (y - truth.origin[1]) * truth.scale, r * truth.scale];
const truthPolys = truth.strokes.map((s) => {
  const out = [toPx(s.start)];
  let p0 = s.start;
  for (let i = 0; i < s.points.length; i += 6) {
    const c = s.points.slice(i, i + 3), p1 = s.points.slice(i + 3, i + 6);
    for (let k = 1; k <= 10; k++) {
      const t = k / 10, u = 1 - t;
      out.push(toPx([0, 1, 2].map((j) => u * u * p0[j] + 2 * u * t * c[j] + t * t * p1[j])));
    }
    p0 = p1;
  }
  return out;
});

const dense = (poly) => {
  const out = [];
  for (let i = 0; i + 1 < poly.length; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  out.push(poly[poly.length - 1]);
  return out;
};
const nearest = (p, pts) => pts.reduce((m, q) => Math.min(m, Math.hypot(p[0] - q[0], p[1] - q[1])), Infinity);

const T = truthPolys.flatMap(dense);
const E = strokes.flatMap((s) => dense(s.points));
const tol = 3; // px
const tD = T.map((p) => nearest(p, E));
const eD = E.map((p) => nearest(p, T));
const pct = (a) => ((100 * a.filter((d) => d <= tol).length) / a.length).toFixed(1);
const mean = (a) => (a.reduce((s, x) => s + x, 0) / a.length).toFixed(2);
const tw = truthPolys.flat().map((p) => p[2]);
const ew = strokes.flatMap((s) => s.points.map((p) => p[2]));

console.log(`variant: ${photo ? "photo-like" : "clean"}  ${w}x${h}px  ${ms.toFixed(0)} ms`);
console.log(`strokes: ${strokes.length} extracted vs ${truth.strokes.length} true`);
console.log(`coverage (true ink found within ${tol}px):   ${pct(tD)}%   mean ${mean(tD)}px`);
console.log(`precision (found ink that is real, ${tol}px): ${pct(eD)}%   mean ${mean(eD)}px`);
console.log(`half-width: true mean ${mean(tw)}px, extracted mean ${mean(ew)}px`);

// overlay
const colors = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#46f0f0", "#f032e6", "#bcbc00", "#008080", "#9a6324"];
const outPng = new PNG({ width: w, height: h });
outPng.data = Buffer.from(data);
const b64 = PNG.sync.write(outPng).toString("base64");
const paths = strokes.map((s, i) =>
  `<polyline points="${s.points.map((p) => p.slice(0, 2).map((v) => v.toFixed(1)).join(",")).join(" ")}" fill="none" stroke="${colors[i % colors.length]}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>` +
  `<circle cx="${s.points[0][0]}" cy="${s.points[0][1]}" r="4" fill="${colors[i % colors.length]}"/>`).join("");
fs.mkdirSync("out", { recursive: true });
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><image href="data:image/png;base64,${b64}" width="${w}" height="${h}" opacity="0.35"/>${paths}</svg>`;
fs.writeFileSync(`out/extract-${photo ? "photo" : "clean"}.svg`, svg);

// strokes in page coordinates, for tools/gnfromjson.py
const page = strokes.map((s) => s.points.map(([x, y, r]) => [x / truth.scale + truth.origin[0], y / truth.scale + truth.origin[1], r / truth.scale]));
fs.writeFileSync(`out/extract-${photo ? "photo" : "clean"}.strokes.json`, JSON.stringify(page));
