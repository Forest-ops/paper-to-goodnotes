import { buildGoodnotes } from "../src/goodnotes.js";
import { toPage } from "../src/layout.js";

const MAX_SIDE = 2000; // photos are downscaled to this long side before extraction

const $ = (id) => document.getElementById(id);
const view = $("view"), ctx = view.getContext("2d");
const status = (msg, err = false) => { $("status").textContent = msg; $("status").className = err ? "status err" : "status"; };

let photo = null;     // { bitmap canvas, width, height }
let strokes = [];     // extracted, in photo pixels
let penWidth = "0.95"; // half-width in points; "photo" = measured from the photo
let template = null;
let jobId = 0;

const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
const pending = new Map();
worker.onmessage = (e) => { const p = pending.get(e.data.id); if (p) { pending.delete(e.data.id); p(e.data); } };
const runWorker = (msg) => new Promise((resolve) => { const id = ++jobId; pending.set(id, resolve); worker.postMessage({ ...msg, id }, [msg.data.buffer]); });

async function loadTemplate() {
  if (!template) template = await (await fetch(new URL("./template.json", import.meta.url))).json();
  return template;
}

async function loadImage(blob) {
  const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
  const s = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return { canvas: c, width: c.width, height: c.height };
}

async function process() {
  if (!photo) return;
  status("Finding strokes…");
  setBusy(true);
  const img = photo.canvas.getContext("2d").getImageData(0, 0, photo.width, photo.height);
  const res = await runWorker({ width: img.width, height: img.height, data: img.data, opts: { sauvolaK: +$("sens").value } });
  setBusy(false);
  if (res.error) { status("Something went wrong reading the photo: " + res.error, true); return; }
  strokes = res.strokes;
  draw();
  status(strokes.length
    ? `Found ${strokes.length} strokes in ${(res.ms / 1000).toFixed(1)} s.`
    : "No handwriting found. Try a brighter photo, or lower the ink sensitivity.");
}

function setBusy(b) {
  $("share").disabled = b || !strokes.length;
  $("save").disabled = b || !strokes.length;
}

function draw() {
  view.hidden = false;
  $("empty").hidden = true;
  view.width = photo.width;
  view.height = photo.height;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, view.width, view.height);
  if ($("showPhoto").checked) {
    ctx.globalAlpha = 0.3;
    ctx.drawImage(photo.canvas, 0, 0);
    ctx.globalAlpha = 1;
  }
  const palette = ["#d6336c", "#2f9e44", "#1c7ed6", "#f08c00", "#7048e8", "#0c8599", "#c2255c", "#5c940d"];
  ctx.lineCap = ctx.lineJoin = "round";
  strokes.forEach((s, i) => {
    ctx.strokeStyle = $("showPhoto").checked ? palette[i % palette.length] : "#111";
    const pts = s.points;
    const fixed = penWidth !== "photo" ? (+penWidth * photo.width) / 612 : null;
    for (let k = 1; k < pts.length; k++) {
      ctx.lineWidth = 2 * (fixed ?? (pts[k - 1][2] + pts[k][2]) / 2);
      ctx.beginPath();
      ctx.moveTo(pts[k - 1][0], pts[k - 1][1]);
      ctx.lineTo(pts[k][0], pts[k][1]);
      ctx.stroke();
    }
  });
  setBusy(false);
}

async function thumbnail() {
  // small black-ink preview for the Goodnotes library
  const w = 500, h = Math.max(120, Math.round((500 * photo.height) / photo.width));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);
  g.strokeStyle = "#111"; g.lineCap = g.lineJoin = "round";
  const s = w / photo.width;
  for (const st of strokes) {
    g.lineWidth = Math.max(1, 2 * st.points[0][2] * s);
    g.beginPath();
    st.points.forEach(([x, y], k) => (k ? g.lineTo(x * s, y * s) : g.moveTo(x * s, y * s)));
    g.stroke();
  }
  const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
  return new Uint8Array(await blob.arrayBuffer());
}

async function makeFile() {
  const t = await loadTemplate();
  let page = toPage(strokes, photo.width, photo.height, t.meta.origin);
  if (penWidth !== "photo") page = page.map((pts) => pts.map(([x, y]) => [x, y, +penWidth]));
  const bytes = await buildGoodnotes(t, page, { thumbnailJpeg: await thumbnail() });
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const name = `Notes ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}.goodnotes`;
  return new File([bytes], name, { type: "application/octet-stream" });
}

async function onPhoto(file) {
  if (!file) return;
  status("Loading photo…");
  try {
    photo = await loadImage(file);
    await process();
  } catch (e) {
    status("Couldn't open that image: " + e.message, true);
  }
}

$("camera").onchange = (e) => onPhoto(e.target.files[0]);
$("library").onchange = (e) => onPhoto(e.target.files[0]);
let sensTimer;
$("sens").oninput = () => { clearTimeout(sensTimer); sensTimer = setTimeout(process, 250); };
$("showPhoto").onchange = () => photo && draw();
$("width").onclick = (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  penWidth = b.dataset.w;
  for (const x of $("width").querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b));
  if (photo) draw();
};

$("share").onclick = async () => {
  try {
    status("Building the Goodnotes file…");
    const file = await makeFile();
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: file.name });
      status("Shared. In Goodnotes it opens as a new whiteboard.");
    } else {
      download(file);
      status("Sharing isn't available here, so the file was saved instead.");
    }
  } catch (e) {
    if (e.name !== "AbortError") status("Couldn't build the file: " + e.message, true);
    else status("");
  }
};
$("save").onclick = async () => {
  try {
    const file = await makeFile();
    download(file);
    status(`Saved ${file.name}. Open it from the Files app and choose Goodnotes.`);
  } catch (e) { status("Couldn't build the file: " + e.message, true); }
};

function download(file) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

// for automated testing: load an image by URL
window.__loadPhotoUrl = async (url) => onPhoto(await (await fetch(url)).blob());
window.__makeFile = makeFile;

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js");
}
loadTemplate().catch(() => status("Couldn't load the Goodnotes template.", true));
