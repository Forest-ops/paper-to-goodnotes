// Print skeleton graph nodes/edges inside a page-pixel box.
//   node test/graph-debug.mjs <photo> <x0> <y0> <x1> <y1>   (page pixels)
import fs from "node:fs";
import jpeg from "jpeg-js";
import { detectPage, warpPage } from "../src/page.js";
import { extractStrokes } from "../src/extract.js";
const [file, ...b] = process.argv.slice(2);
const [x0, y0, x1, y1] = b.map(Number);
const img = jpeg.decode(fs.readFileSync(file), { useTArray: true });
const page = warpPage(img, detectPage(img), { maxWidth: 1800 });
const w = page.width;
const inBox = (p) => { const x = p % w, y = Math.floor(p / w); return x >= x0 && x <= x1 && y >= y0 && y <= y1; };
extractStrokes(page, { debug: (g, half) => {
  console.log("typicalHalf", half);
  for (const e of g.edges) if (e.px.some(inBox))
    console.log(`edge ${e.id} ${e.a}->${e.b} len ${e.px.length} ${e.alive ? "" : "DEAD"} from ${e.px[0] % w},${Math.floor(e.px[0] / w)} to ${e.px.at(-1) % w},${Math.floor(e.px.at(-1) / w)}`);
} });
