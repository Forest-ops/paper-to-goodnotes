// Heavy lifting off the main thread: find and straighten the page, then extract strokes.
// The straightened page is kept so sensitivity changes only re-run extraction.
import { detectPage, warpPage } from "../src/page.js";
import { extractStrokes } from "../src/extract.js";

let photo = null; // last photo as sent
let page = null;  // straightened page (or the photo itself)
let found = false;

self.onmessage = (e) => {
  const { id, type } = e.data;
  try {
    const t0 = performance.now();
    if (type === "photo" || type === "crop") {
      if (type === "photo") photo = { data: e.data.data, width: e.data.width, height: e.data.height };
      const quad = e.data.findPage ? detectPage(photo) : null;
      found = !!quad;
      page = quad ? warpPage(photo, quad, { maxWidth: 1800 }) : photo;
    }
    const strokes = extractStrokes(page, e.data.opts);
    const msg = { id, strokes, ms: performance.now() - t0, found, width: page.width, height: page.height };
    if (type !== "extract") {
      const copy = new Uint8ClampedArray(page.data); // the page stays here for re-runs
      msg.page = copy;
      self.postMessage(msg, [copy.buffer]);
    } else {
      self.postMessage(msg);
    }
  } catch (err) {
    self.postMessage({ id, error: String((err && err.stack) || err) });
  }
};
