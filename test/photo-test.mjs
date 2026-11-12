// Run the full photo pipeline on a real photo and save overlays to look at.
//   node test/photo-test.mjs samples/real/catapult.jpg [sensitivity 0..1]
// Writes out/photo-page.png (straightened page) and out/photo-overlay.svg (+ .png via Edge).
import fs from "node:fs";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { detectPage, warpPage } from "../src/page.js";
import { extractStrokes } from "../src/extract.js";

const file = process.argv[2] || "samples/real/catapult.jpg";
const k = process.argv[3] ? +process.argv[3] : undefined;
const img = jpeg.decode(fs.readFileSync(file), { useTArray: true });
let t = performance.now();
const quad = detectPage(img);
const page = quad ? warpPage(img, quad) : img;
const tPage = performance.now() - t;
t = performance.now();
const stats = {};
let dark;
const strokes = extractStrokes(page, { ...(k !== undefined ? { sensitivity: k } : {}), stats, darkOut: (d) => { dark = Float32Array.from(d); } });
const tEx = performance.now() - t;

console.log(`photo ${img.width}x${img.height}; page ${quad ? "found" : "NOT found"} -> ${page.width}x${page.height} in ${tPage.toFixed(0)} ms`);
if (quad) console.log("corners", quad.map((p) => p.map((v) => v.toFixed(0)).join(",")).join("  "));
console.log(`strokes: ${strokes.length} in ${tEx.toFixed(0)} ms`, JSON.stringify(stats));

fs.mkdirSync("out", { recursive: true });
const png = new PNG({ width: page.width, height: page.height });
png.data = Buffer.from(page.data.buffer, page.data.byteOffset, page.data.length);
fs.writeFileSync("out/photo-page.png", PNG.sync.write(png));
// darkness map after line/blob removal, contrast x5, for tuning
const dm = new PNG({ width: page.width, height: page.height });
for (let i = 0; i < dark.length; i++) { const v = 255 - Math.min(255, dark[i] * 5 * 255); dm.data[i * 4] = dm.data[i * 4 + 1] = dm.data[i * 4 + 2] = v; dm.data[i * 4 + 3] = 255; }
fs.writeFileSync("out/photo-dark.png", PNG.sync.write(dm));
const colors = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#0aa", "#f032e6", "#9a6324"];
const paths = strokes.map((s, i) =>
  `<polyline points="${s.points.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ")}" fill="none" stroke="${colors[i % colors.length]}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`).join("");
fs.writeFileSync("out/photo-overlay.svg",
  `<svg xmlns="http://www.w3.org/2000/svg" width="${page.width}" height="${page.height}"><image href="photo-page.png" width="${page.width}" height="${page.height}" opacity="0.45"/>${paths}</svg>`);
