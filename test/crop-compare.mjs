// Compare extraction variants on one region of a real photo.
//   node test/crop-compare.mjs <photo> <x0> <y0> <x1> <y1> (fractions of the page)
import fs from "node:fs";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { detectPage, warpPage } from "../src/page.js";
import { extractStrokes } from "../src/extract.js";

const [file, fx0, fy0, fx1, fy1] = process.argv.slice(2);
const img = jpeg.decode(fs.readFileSync(file), { useTArray: true });
const quad = detectPage(img);
const page = quad ? warpPage(img, quad, { maxWidth: 1800 }) : img;
const png = new PNG({ width: page.width, height: page.height });
png.data = Buffer.from(page.data.buffer, page.data.byteOffset, page.data.length);
fs.writeFileSync("out/cmp-page.png", PNG.sync.write(png));
const vx = +fx0 * page.width, vy = +fy0 * page.height, vw = (fx1 - fx0) * page.width, vh = (fy1 - fy0) * page.height;
const variants = {
  default: {},


};
let html = '<!doctype html><body style="margin:0;background:#fff;font:14px sans-serif">';
for (const [name, opt] of Object.entries(variants)) {
  const st = {};
  const s = extractStrokes(page, { ...opt, stats: st });
  const lines = s.map((k) => `<polyline points="${k.points.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ")}" fill="none" stroke="#e03" stroke-width="0.8" stroke-linecap="round"/>`).join("");
  html += `<div>${name}: ${s.length} strokes ${JSON.stringify(st)}</div><svg width="900" height="${Math.round(900 * vh / vw)}" viewBox="${vx} ${vy} ${vw} ${vh}"><image href="cmp-page.png" width="${page.width}" height="${page.height}" opacity="0.5"/>${lines}</svg>`;
}
fs.writeFileSync("out/cmp.html", html);
