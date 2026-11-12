// Real photo -> straightened page -> strokes -> .goodnotes, same steps as the app.
//   node test/photo-build.mjs samples/real/catapult.jpg out/7_catapult.goodnotes
import fs from "node:fs";
import jpeg from "jpeg-js";
import { detectPage, warpPage } from "../src/page.js";
import { extractStrokes } from "../src/extract.js";
import { buildGoodnotes } from "../src/goodnotes.js";
import { toPage } from "../src/layout.js";

const [src = "samples/real/catapult.jpg", out = "out/7_catapult.goodnotes"] = process.argv.slice(2);
const img = jpeg.decode(fs.readFileSync(src), { useTArray: true });
const quad = detectPage(img);
const page = quad ? warpPage(img, quad, { maxWidth: 1800 }) : img;
const strokes = extractStrokes(page);
const template = JSON.parse(fs.readFileSync("app/template.json", "utf8"));
const pts = toPage(strokes, page.width, page.height, template.meta.origin).map((s) => s.map(([x, y]) => [x, y, 0.95]));
fs.writeFileSync(out, await buildGoodnotes(template, pts));
console.log(`${strokes.length} strokes -> ${out}`);
