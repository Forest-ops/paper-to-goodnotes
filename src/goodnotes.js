// Build a .goodnotes file from pen strokes, starting from app/template.json
// (a blank Goodnotes whiteboard made by tools/maketemplate.py).
// Format notes: docs/goodnotes-format.md. Runs in the browser and in Node 18+.
//
//   const bytes = await buildGoodnotes(template, strokes, { thumbnailJpeg });
//   strokes: [[[x, y, halfWidth], ...], ...] in page points (whiteboard coordinates)

// ------------------------------------------------------------------ protobuf

function readVarint(buf, i) {
  let result = 0n, shift = 0n;
  for (;;) {
    const b = buf[i++];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return [result, i];
    shift += 7n;
  }
}

export function parseFields(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let key;
    [key, i] = readVarint(buf, i);
    const fn = Number(key >> 3n), wt = Number(key & 7n);
    let v;
    if (wt === 0) [v, i] = readVarint(buf, i);
    else if (wt === 2) {
      let len;
      [len, i] = readVarint(buf, i);
      v = buf.subarray(i, i + Number(len));
      i += Number(len);
    } else if (wt === 5) { v = buf.subarray(i, i + 4); i += 4; }
    else if (wt === 1) { v = buf.subarray(i, i + 8); i += 8; }
    else throw new Error(`wire type ${wt}`);
    out.push([fn, wt, v]);
  }
  return out;
}

function varint(n) {
  let v = BigInt.asUintN(64, BigInt(n));
  const out = [];
  do {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    out.push(v ? b | 0x80 : b);
  } while (v);
  return out;
}

export function encodeFields(fields) {
  const parts = [];
  for (const [fn, wt, v] of fields) {
    parts.push(Uint8Array.from(varint((fn << 3) | wt)));
    if (wt === 0) parts.push(Uint8Array.from(varint(v)));
    else if (wt === 2) { parts.push(Uint8Array.from(varint(v.length))); parts.push(v); }
    else parts.push(v);
  }
  return concat(parts);
}

const get = (fields, fn) => fields.find((f) => f[0] === fn)?.[2];
const set = (fields, fn, wt, v) => fields.map((f) => (f[0] === fn ? [fn, wt, v] : f));

function concat(parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ------------------------------------------------------------------ stroke point data

const STROKE_SIG = "vA(v)A(u)A(u)A(v)A(v)A(u)A(u)A(u)A(u)A(v)";

function encodeTpl(vals) {
  // tokens: v = u16, u = f32, A(x) = u32 count + items
  const toks = [];
  for (let j = 0; j < STROKE_SIG.length;) {
    if (STROKE_SIG[j] === "A") { toks.push(["A", STROKE_SIG[j + 2]]); j += 4; }
    else { toks.push(["S", STROKE_SIG[j]]); j += 1; }
  }
  let size = STROKE_SIG.length + 1;
  toks.forEach(([k, t], i) => { size += k === "S" ? (t === "v" ? 2 : 4) : 4 + vals[i].length * (t === "v" ? 2 : 4); });
  const buf = new ArrayBuffer(8 + size);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  u8.set([0x74, 0x70, 0x6c, 0]); // "tpl\0"
  dv.setUint32(4, 8 + size, true);
  let o = 8;
  for (const c of STROKE_SIG) u8[o++] = c.charCodeAt(0);
  u8[o++] = 0;
  toks.forEach(([k, t], i) => {
    const put = (x) => { if (t === "v") { dv.setUint16(o, x, true); o += 2; } else { dv.setFloat32(o, x, true); o += 4; } };
    if (k === "S") put(vals[i]);
    else { dv.setUint32(o, vals[i].length, true); o += 4; vals[i].forEach(put); }
  });
  return u8;
}

// Apple compression framework LZ4 framing with one literal-only LZ4 block.
function appleLz4(data) {
  const n = data.length;
  const tok = [];
  if (n < 15) tok.push(n << 4);
  else { tok.push(0xf0); let r = n - 15; while (r >= 255) { tok.push(255); r -= 255; } tok.push(r); }
  const blockLen = tok.length + n;
  const out = new Uint8Array(12 + blockLen + 4);
  const dv = new DataView(out.buffer);
  out.set([0x62, 0x76, 0x34, 0x31]); // bv41
  dv.setUint32(4, n, true);
  dv.setUint32(8, blockLen, true);
  out.set(tok, 12);
  out.set(data, 12 + tok.length);
  out.set([0x62, 0x76, 0x34, 0x24], 12 + blockLen); // bv4$
  return out;
}

// ------------------------------------------------------------------ stroke geometry

const norm = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const quadPt = (p0, c, p1, t) => [0, 1, 2].map((k) => (1 - t) ** 2 * p0[k] + 2 * (1 - t) * t * c[k] + t * t * p1[k]);
function quadTan(p0, c, p1, t) {
  let dx = 2 * (1 - t) * (c[0] - p0[0]) + 2 * t * (p1[0] - c[0]);
  let dy = 2 * (1 - t) * (c[1] - p0[1]) + 2 * t * (p1[1] - c[1]);
  if (dx === 0 && dy === 0) { dx = p1[0] - p0[0]; dy = p1[1] - p0[1]; }
  return Math.atan2(dy, dx);
}
function sideCubics(s) {
  const out = [];
  for (let i = 0; i + 1 < s.length; i++) {
    const p0 = s[Math.max(i - 1, 0)], p1 = s[i], p2 = s[i + 1], p3 = s[Math.min(i + 2, s.length - 1)];
    out.push([p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]]);
  }
  return out;
}

// Same construction as tools/gnwrite.py build_stroke: a quadratic centerline plus one
// closed capsule outline per centerline segment (cubic sides, round-cap arcs).
export function buildStroke(pts, steps = 3) {
  const quads = [];
  let prev = pts[0];
  for (let i = 1; i < pts.length - 1; i++) {
    const c = pts[i], nxt = pts[i + 1];
    const end = i === pts.length - 2 ? nxt : c.map((v, k) => (v + nxt[k]) / 2);
    quads.push([prev, c, end]);
    prev = end;
  }
  if (!quads.length) {
    const [a, b] = [pts[0], pts[pts.length - 1]];
    quads.push([a, a.map((v, k) => (v + b[k]) / 2), b]);
  }
  const spineVerbs = [0, ...quads.map(() => 1)];
  const spineStart = [...pts[0]];
  const spinePts = quads.flatMap(([, c, e]) => [...c, ...e]);
  const counts = [], verbs = [], starts = [], opts = [], arcs = [], flags = [];
  for (const [p0, c, p1] of quads) {
    const left = [], right = [];
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const [x, y, w] = quadPt(p0, c, p1, t);
      const th = quadTan(p0, c, p1, t);
      left.push([x + w * Math.cos(th + Math.PI / 2), y + w * Math.sin(th + Math.PI / 2)]);
      right.push([x + w * Math.cos(th - Math.PI / 2), y + w * Math.sin(th - Math.PI / 2)]);
    }
    const th0 = quadTan(p0, c, p1, 0), th1 = quadTan(p0, c, p1, 1);
    const seg = [0];
    starts.push(...left[0]);
    for (const cub of sideCubics(left)) { seg.push(2); opts.push(...cub); }
    seg.push(3);
    arcs.push(p1[0], p1[1], p1[2], norm(th1 + Math.PI / 2), norm(th1 - Math.PI / 2));
    flags.push(1);
    for (const cub of sideCubics([...right].reverse())) { seg.push(2); opts.push(...cub); }
    seg.push(3);
    arcs.push(p0[0], p0[1], p0[2], norm(th0 - Math.PI / 2), norm(th0 - 1.5 * Math.PI));
    flags.push(1);
    counts.push(seg.length);
    verbs.push(...seg);
  }
  return [2, spineVerbs, spineStart, spinePts, counts, verbs, starts, [], opts, arcs, flags];
}

// Mirrors tools/gnwrite.py validate_stroke. A stroke Goodnotes can't handle can crash
// the app on every launch, so nothing is written unless every stroke passes.
export function validateStroke(v) {
  const [version, sv, start, sp, counts, verbs, starts, unk, opts, arcs, flags] = v;
  const count = (x) => verbs.filter((q) => q === x).length;
  const check = (ok, what) => { if (!ok) throw new Error(`invalid stroke: ${what}`); };
  check(version === 2, "version");
  check(sv.length >= 2 && sv[0] === 0 && sv.slice(1).every((q) => q === 1), "centerline verbs");
  check(start.length === 3, "centerline start");
  check(sp.length === 6 * (sv.length - 1), "centerline points");
  check(counts.length === sv.length - 1, "one outline sub-path per segment");
  check(counts.every((c) => c >= 3) && counts.reduce((a, b) => a + b, 0) === verbs.length, "outline counts");
  check(verbs.every((q) => q === 0 || q === 2 || q === 3), "outline verb types");
  let k = 0;
  for (const c of counts) { check(verbs[k] === 0 && !verbs.slice(k + 1, k + c).includes(0), "sub-path moveTo"); k += c; }
  check(starts.length === 2 * count(0), "outline starts");
  check(unk.length === 0, "array 7 empty");
  check(opts.length === 6 * count(2), "cubic points");
  check(arcs.length === 5 * count(3) && count(3) >= 1, "arcs");
  check(flags.length === count(3) && flags.every((f) => f === 1), "arc flags");
  check([...start, ...sp, ...starts, ...opts, ...arcs].every(Number.isFinite), "non-finite number");
  check([start[2], ...sp.filter((_, i) => i % 3 === 2)].every((w) => w > 0), "positive widths");
}

// ------------------------------------------------------------------ document

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const utf8 = (s) => new TextEncoder().encode(s);
const randU32 = () => crypto.getRandomValues(new Uint32Array(1))[0];
// crypto.randomUUID only exists on HTTPS pages; build a v4 UUID by hand elsewhere.
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function buildGoodnotes(template, strokes, { thumbnailJpeg } = {}) {
  const { meta } = template;
  const files = new Map(template.entries.map((e) => [e.name, b64(e.data)]));
  const hdrT = parseFields(b64(meta.strokeHeader));
  const bodyT = parseFields(b64(meta.strokeBody));
  const recs = [];
  let seq = meta.nextSeq;
  for (const pts of strokes) {
    if (pts.length < 2) continue;
    const vals = buildStroke(pts);
    validateStroke(vals);
    const id = utf8(uuid().toUpperCase());
    const ver = encodeFields([[1, 0, 2], [2, 0, randU32()]]);
    let hdr = set(set(set(hdrT, 1, 2, id), 2, 2, ver), 9, 0, seq++);
    let body = set(set(set(bodyT, 1, 2, id), 2, 2, appleLz4(encodeTpl(vals))), 15, 2, ver);
    for (const r of [encodeFields(hdr), encodeFields([[7, 2, encodeFields(body)]])]) {
      recs.push(Uint8Array.from(varint(r.length)), r);
    }
  }
  files.set(meta.notesName, concat([files.get(meta.notesName), ...recs]));
  if (thumbnailJpeg) files.set(meta.thumbnailName, thumbnailJpeg);
  return zip(template.entries.map((e) => [e.name, files.get(e.name)]));
}

// ------------------------------------------------------------------ zip

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(d) {
  let c = 0xffffffff;
  for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data) {
  if (typeof CompressionStream === "undefined") return null;
  const s = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

async function zip(entries) {
  const local = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const [name, data] of entries) {
    const nm = utf8(name);
    const crc = crc32(data);
    let comp = data.length ? await deflateRaw(data) : null;
    const method = comp ? 8 : 0;
    if (!comp) comp = data;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
    h.setUint16(8, method, true); h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true);
    h.setUint32(14, crc, true); h.setUint32(18, comp.length, true); h.setUint32(22, data.length, true);
    h.setUint16(26, nm.length, true); h.setUint16(28, 0, true);
    local.push(new Uint8Array(h.buffer), nm, comp);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 0x0314, true); c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true); c.setUint16(10, method, true); c.setUint16(12, dosTime, true);
    c.setUint16(14, dosDate, true); c.setUint32(16, crc, true); c.setUint32(20, comp.length, true);
    c.setUint32(24, data.length, true); c.setUint16(28, nm.length, true);
    c.setUint32(38, 0x81a40000, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), nm);
    offset += 30 + nm.length + comp.length;
  }
  const cd = concat(central);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true);
  e.setUint32(12, cd.length, true); e.setUint32(16, offset, true);
  return concat([...local, cd, new Uint8Array(e.buffer)]);
}
