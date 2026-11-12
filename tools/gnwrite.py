"""Build test .goodnotes files from the sample, to see what Goodnotes accepts.

Usage: python gnwrite.py <sample.goodnotes> <out-dir>

Writes:
  1_roundtrip.goodnotes   every record re-encoded by our code, no changes
  2_moved.goodnotes       the T crossbar moved down
  3_copied.goodnotes      the "g" stroke duplicated to the right as a new stroke
  4_synthetic.goodnotes   a wavy underline built from scratch (centerline + outline)

A stroke with no outline data crashed Goodnotes on every launch, so validate_stroke()
checks every stroke written.
"""
import io
import math
import os
import random
import struct
import sys
import uuid
import zipfile

from gndump import apple_decompress, records, try_parse
from gnstrokes import parse_tpl

# ---------------------------------------------------------------- protobuf


def enc_varint(n):
    out = bytearray()
    n &= (1 << 64) - 1
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def enc_fields(fields):
    out = bytearray()
    for fn, wt, v in fields:
        out += enc_varint((fn << 3) | wt)
        if wt == 0:
            out += enc_varint(v)
        elif wt == 2:
            out += enc_varint(len(v)) + v
        else:
            out += v
    return bytes(out)


def enc_records(recs):
    return b"".join(enc_varint(len(r)) + r for r in recs)


def get(fields, fn):
    for f, _, v in fields:
        if f == fn:
            return v
    return None


def replace(fields, fn, wt, value):
    """Replace field fn (or append it) and return a new list."""
    out, done = [], False
    for f, w, v in fields:
        if f == fn and not done:
            out.append((fn, wt, value))
            done = True
        else:
            out.append((f, w, v))
    if not done:
        out.append((fn, wt, value))
    return out


# ---------------------------------------------------------------- tpl + compression

STROKE_SIG = "vA(v)A(u)A(u)A(v)A(v)A(u)A(u)A(u)A(u)A(v)"


def enc_tpl(sig, vals):
    body = bytearray(sig.encode() + b"\0")
    toks, j = [], 0
    while j < len(sig):
        if sig[j] == "A":
            toks.append(("A", sig[j + 2]))
            j += 4
        else:
            toks.append(("S", sig[j]))
            j += 1
    for (kind, t), v in zip(toks, vals):
        fmt = "<H" if t == "v" else "<f"
        if kind == "S":
            body += struct.pack(fmt, v)
        else:
            body += struct.pack("<I", len(v))
            for x in v:
                body += struct.pack(fmt, x)
    return b"tpl\0" + struct.pack("<I", len(body) + 8) + bytes(body)


def lz4_literal_block(data):
    """A valid LZ4 block holding only literals (no compression, but any LZ4 decoder reads it)."""
    n = len(data)
    out = bytearray()
    if n < 15:
        out.append(n << 4)
    else:
        out.append(0xF0)
        rest = n - 15
        while rest >= 255:
            out.append(255)
            rest -= 255
        out.append(rest)
    return bytes(out) + data


def apple_compress(data):
    blk = lz4_literal_block(data)
    return b"bv41" + struct.pack("<II", len(data), len(blk)) + blk + b"bv4$"


# ---------------------------------------------------------------- stroke geometry


def norm(a):
    return math.atan2(math.sin(a), math.cos(a))


def quad_pt(p0, c, p1, t):
    u = 1 - t
    return tuple(u * u * p0[k] + 2 * u * t * c[k] + t * t * p1[k] for k in range(3))


def quad_tan(p0, c, p1, t):
    dx = 2 * (1 - t) * (c[0] - p0[0]) + 2 * t * (p1[0] - c[0])
    dy = 2 * (1 - t) * (c[1] - p0[1]) + 2 * t * (p1[1] - c[1])
    if dx == 0 and dy == 0:
        dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    return math.atan2(dy, dx)


def side_cubics(samples):
    """Catmull-Rom through sample points -> list of cubic segments (c1, c2, end)."""
    out = []
    n = len(samples)
    for i in range(n - 1):
        p0 = samples[max(i - 1, 0)]
        p1 = samples[i]
        p2 = samples[i + 1]
        p3 = samples[min(i + 2, n - 1)]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        out.append((c1, c2, p2))
    return out


def build_stroke(spine_pts, with_outline=True, steps=3):
    """spine_pts: list of (x, y, halfwidth). Returns the tpl value list for STROKE_SIG.

    Centerline: moveTo first point, then quadTo using each interior point as the control
    and the midpoint to the next as the end (the last segment ends on the last point).
    Outline: one closed capsule per centerline segment, like Goodnotes writes.
    """
    pts = spine_pts
    start = pts[0]
    quads = []
    prev = start
    for i in range(1, len(pts) - 1):
        c = pts[i]
        nxt = pts[i + 1]
        end = nxt if i == len(pts) - 2 else tuple((c[k] + nxt[k]) / 2 for k in range(3))
        quads.append((prev, c, end))
        prev = end
    if not quads:  # two points: straight segment
        a, b = pts[0], pts[-1]
        quads.append((a, tuple((a[k] + b[k]) / 2 for k in range(3)), b))

    spine_verbs = [0] + [1] * len(quads)
    spine_start = list(start)
    spine_points = []
    for _, c, e in quads:
        spine_points += list(c) + list(e)

    counts, verbs, starts, opts, arcs, arcflags = [], [], [], [], [], []
    if with_outline:
        for p0, c, p1 in quads:
            ts = [k / steps for k in range(steps + 1)]
            left, right = [], []
            for t in ts:
                x, y, w = quad_pt(p0, c, p1, t)
                th = quad_tan(p0, c, p1, t)
                left.append((x + w * math.cos(th + math.pi / 2), y + w * math.sin(th + math.pi / 2)))
                right.append((x + w * math.cos(th - math.pi / 2), y + w * math.sin(th - math.pi / 2)))
            th0 = quad_tan(p0, c, p1, 0)
            th1 = quad_tan(p0, c, p1, 1)
            seg_verbs = [0]
            starts += list(left[0])
            for c1, c2, e in side_cubics(left):
                seg_verbs.append(2)
                opts += list(c1) + list(c2) + list(e)
            # cap at the end: from left side, round the front, to the right side
            seg_verbs.append(3)
            arcs += [p1[0], p1[1], p1[2], norm(th1 + math.pi / 2), norm(th1 - math.pi / 2)]
            arcflags.append(1)
            for c1, c2, e in side_cubics(right[::-1]):
                seg_verbs.append(2)
                opts += list(c1) + list(c2) + list(e)
            # cap at the start: from right side, round the back, to the left side
            seg_verbs.append(3)
            arcs += [p0[0], p0[1], p0[2], norm(th0 - math.pi / 2), norm(th0 - 3 * math.pi / 2)]
            arcflags.append(1)
            counts.append(len(seg_verbs))
            verbs += seg_verbs

    return [2, spine_verbs, spine_start, spine_points, counts, verbs, starts, [], opts, arcs, arcflags]


def transform_vals(vals, dx, dy):
    """Shift every coordinate in a decoded stroke by (dx, dy)."""
    v = list(vals)
    v[2] = [x + (dx, dy, 0)[k % 3] for k, x in enumerate(v[2])]
    v[3] = [x + (dx, dy, 0)[k % 3] for k, x in enumerate(v[3])]
    v[6] = [x + (dx, dy)[k % 2] for k, x in enumerate(v[6])]
    v[8] = [x + (dx, dy)[k % 2] for k, x in enumerate(v[8])]
    v[9] = [x + (dx, dy, 0, 0, 0)[k % 5] for k, x in enumerate(v[9])]
    return v


# ---------------------------------------------------------------- document


class Doc:
    def __init__(self, path):
        self.zin = zipfile.ZipFile(path)
        self.names = [i.filename for i in self.zin.infolist()]
        self.files = {n: self.zin.read(n) for n in self.names}
        self.notes_name = [n for n in self.names if n.startswith("notes/")][0]
        self.recs = [try_parse(r) for r in records(self.files[self.notes_name])]

    def strokes(self):
        """Yield (header_index, body_index, uuid, vals) for live (not deleted) strokes."""
        for i, f in enumerate(self.recs):
            if get(f, 16) == 24 and get(f, 3) is None:
                body = get(self.recs[i + 1], 7)
                bf = try_parse(body)
                _, vals = parse_tpl(apple_decompress(get(bf, 2)))
                yield i, i + 1, get(f, 1).decode(), vals

    def set_stroke_vals(self, body_index, vals):
        bf = try_parse(get(self.recs[body_index], 7))
        bf = replace(bf, 2, 2, apple_compress(enc_tpl(STROKE_SIG, vals)))
        self.recs[body_index] = replace(self.recs[body_index], 7, 2, enc_fields(bf))

    def add_stroke(self, template_hdr, template_body, vals):
        new_id = str(uuid.uuid4()).upper().encode()
        ver = enc_fields([(1, 0, 2), (2, 0, random.getrandbits(32))])
        seq = max(get(f, 9) or 0 for f in self.recs) + 1
        hdr = list(self.recs[template_hdr])
        hdr = replace(hdr, 1, 2, new_id)
        hdr = replace(hdr, 2, 2, ver)
        hdr = replace(hdr, 9, 0, seq)
        bf = try_parse(get(self.recs[template_body], 7))
        bf = replace(bf, 1, 2, new_id)
        bf = replace(bf, 2, 2, apple_compress(enc_tpl(STROKE_SIG, vals)))
        bf = replace(bf, 15, 2, ver)
        self.recs.append(hdr)
        self.recs.append([(7, 2, enc_fields(bf))])
        return new_id.decode()

    def save(self, path):
        files = dict(self.files)
        files[self.notes_name] = enc_records([enc_fields(f) for f in self.recs])
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
            for n in self.names:
                z.writestr(n, files[n])


def bbox(vals):
    pts = vals[2] + vals[3]
    xs, ys = pts[0::3], pts[1::3]
    return min(xs), min(ys), max(xs), max(ys)


def main():
    src, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    random.seed(1)

    # 1. round trip: our encoder must reproduce the exact bytes
    d = Doc(src)
    orig = d.files[d.notes_name]
    again = enc_records([enc_fields(f) for f in d.recs])
    assert again == orig, "re-encoding is not byte-identical"
    for _, b, _, vals in d.strokes():  # also re-encode every stroke blob
        d.set_stroke_vals(b, vals)
    d.save(os.path.join(outdir, "1_roundtrip.goodnotes"))

    # 2. move the T crossbar (widest, flattest stroke) down by 25 units
    d = Doc(src)
    s = list(d.strokes())
    bar = max(s, key=lambda t: (bbox(t[3])[2] - bbox(t[3])[0]) - (bbox(t[3])[3] - bbox(t[3])[1]))
    d.set_stroke_vals(bar[1], transform_vals(bar[3], 0, 25))
    d.save(os.path.join(outdir, "2_moved.goodnotes"))

    # 3. copy the "g" (rightmost stroke) 45 units to the right as a new stroke
    d = Doc(src)
    s = list(d.strokes())
    g = max(s, key=lambda t: bbox(t[3])[2])
    d.add_stroke(g[0], g[1], transform_vals(g[3], 45, 0))
    d.save(os.path.join(outdir, "3_copied.goodnotes"))

    # 4. a wavy underline built from scratch
    allb = [bbox(t[3]) for t in s]
    x0 = min(b[0] for b in allb)
    x1 = max(b[2] for b in allb)
    y = max(b[3] for b in allb) + 20
    wave = [(x0 + (x1 - x0) * k / 40, y + 6 * math.sin(k * math.pi / 5), 0.8) for k in range(41)]
    d = Doc(src)
    tmpl = list(d.strokes())[0]
    d.add_stroke(tmpl[0], tmpl[1], build_stroke(wave))
    d.save(os.path.join(outdir, "4_synthetic.goodnotes"))

    # 5_spine_only (no outline) crashed Goodnotes on launch. Never write it again.
    # Every file written above must pass the same checks real Goodnotes strokes pass.
    for t in Doc(src).strokes():
        validate_stroke(t[3])
    for name in ("1_roundtrip", "2_moved", "3_copied", "4_synthetic"):
        for t in Doc(os.path.join(outdir, name + ".goodnotes")).strokes():
            validate_stroke(t[3])
    print("ok, all strokes valid")


def validate_stroke(vals):
    """Raise if a stroke breaks any invariant seen in real Goodnotes data.

    A stroke Goodnotes cannot handle can crash the app on every launch, so be strict.
    """
    version, sv, start, sp, counts, verbs, starts, unk, opts, arcs, flags = vals
    assert version == 2, "version"
    assert len(sv) >= 2 and sv[0] == 0 and all(v == 1 for v in sv[1:]), "centerline verbs"
    assert len(start) == 3, "centerline start"
    assert len(sp) == 6 * (len(sv) - 1), "centerline points"
    assert len(counts) == len(sv) - 1, "one outline sub-path per centerline segment"
    assert all(c >= 3 for c in counts) and sum(counts) == len(verbs), "outline counts"
    assert set(verbs) <= {0, 2, 3}, "outline verb types"
    k = 0
    for c in counts:
        assert verbs[k] == 0 and 0 not in verbs[k + 1:k + c], "each sub-path starts with one moveTo"
        k += c
    assert len(starts) == 2 * verbs.count(0), "outline starts"
    assert unk == [], "array 7 is always empty"
    assert len(opts) == 6 * verbs.count(2), "outline cubic points"
    assert len(arcs) == 5 * verbs.count(3) and verbs.count(3) >= 1, "arcs"
    assert flags == [1] * verbs.count(3), "arc flags"
    for x in start + sp + starts + opts + arcs:
        assert math.isfinite(x), "non-finite number"
    assert all(w > 0 for w in sp[2::3] + start[2:3]), "widths must be positive"


if __name__ == "__main__":
    main()
