// List strokes dropped by the final filters inside a page region, and why.
//   node test/why-dropped.mjs <photo> <x0> <y0> <x1> <y1>   (fractions of the page)
import fs from "node:fs";
import jpeg from "jpeg-js";
import { detectPage, warpPage } from "../src/page.js";
import { extractStrokes } from "../src/extract.js";
const [file, ...f] = process.argv.slice(2);
const img = jpeg.decode(fs.readFileSync(file), { useTArray: true });
const page = warpPage(img, detectPage(img), { maxWidth: 1800 });
const [x0, y0, x1, y1] = f.map((v, i) => +v * (i % 2 ? page.height : page.width));
const kept = extractStrokes(page, { ...JSON.parse(process.env.OPTS || "{}"), dropped: (why, pts) => {
  if (pts.some(([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1))
    console.log("dropped:", why, pts.length, "pts, bbox", [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))].map(Math.round).join(","));
} });
console.log("kept in region:", kept.filter((s) => s.points.some(([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1)).length);
