// Runs stroke extraction off the main thread so the page stays responsive.
import { extractStrokes } from "../src/extract.js";

self.onmessage = (e) => {
  const { id, width, height, data, opts } = e.data;
  try {
    const t0 = performance.now();
    const strokes = extractStrokes({ data, width, height }, opts);
    self.postMessage({ id, strokes, ms: performance.now() - t0 });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.stack || err) });
  }
};
