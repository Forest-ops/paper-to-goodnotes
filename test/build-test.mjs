// End to end in Node: test image -> extract strokes -> JS writer -> .goodnotes file.
//   node test/build-test.mjs  ->  out/6_app_output.goodnotes
// Check it with: python tools/gnstrokes.py (after unzipping) or tools/gnwrite.py's validator.
import fs from "node:fs";
import { PNG } from "pngjs";
import { extractStrokes } from "../src/extract.js";
import { buildGoodnotes } from "../src/goodnotes.js";
import { toPage } from "../src/layout.js";

const template = JSON.parse(fs.readFileSync("app/template.json", "utf8"));
const png = PNG.sync.read(fs.readFileSync("samples/synthetic/testing.png"));
const strokes = extractStrokes({ data: png.data, width: png.width, height: png.height });
// "Medium" pen width, as picked in the app
const page = toPage(strokes, png.width, png.height, template.meta.origin).map((pts) => pts.map(([x, y]) => [x, y, 0.95]));
const bytes = await buildGoodnotes(template, page);
fs.writeFileSync("out/6_app_output.goodnotes", bytes);
console.log(`${strokes.length} strokes -> out/6_app_output.goodnotes (${bytes.length} bytes)`);
