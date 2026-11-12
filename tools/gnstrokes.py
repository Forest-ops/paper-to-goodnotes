"""Extract ink strokes from an unzipped .goodnotes notes/<uuid> file and render them to SVG.

Usage: python gnstrokes.py <notes-file> <out.svg> [truth.json]
Env: CLEAN=1 hides the red centerlines, SCALE=<px per point> (default 4).
"""
import struct
import sys

from gndump import apple_decompress, records, try_parse

SWEEP = int(__import__("os").environ.get("SWEEP", "0"))

CLEAN = bool(__import__("os").environ.get("CLEAN"))
SCALE = float(__import__("os").environ.get("SCALE", "4"))

ARRAY_NAMES = [
    "spine_verbs",    # u16: 0 = moveTo, 1 = quadTo
    "spine_start",    # f32 xyw (one point)
    "spine_points",   # f32 xyw, 2 per quadTo
    "outline_counts", # u16: verbs per outline sub-path
    "outline_verbs",  # u16: 0 = moveTo, 2 = lineTo, 3 = quadTo
    "outline_starts", # f32 xy, one per sub-path
    "unknown6",       # f32, empty so far
    "outline_points", # f32 xy
    "unknown8",       # f32, groups of 5
    "unknown9",       # u16
]


def parse_tpl(raw):
    assert raw[:4] == b"tpl\0", raw[:4]
    (total,) = struct.unpack_from("<I", raw, 4)
    assert total == len(raw)
    end = raw.index(b"\0", 8)
    sig = raw[8:end].decode()
    i = end + 1
    # signature tokens: 'v' = u16 scalar, 'u' = f32 scalar, 'A(x)' = u32 count + items
    toks = []
    j = 0
    while j < len(sig):
        if sig[j] == "A":
            toks.append(("A", sig[j + 2]))
            j += 4
        else:
            toks.append(("S", sig[j]))
            j += 1
    vals = []
    for kind, t in toks:
        fmt, size = ("<H", 2) if t == "v" else ("<f", 4)
        if kind == "S":
            vals.append(struct.unpack_from(fmt, raw, i)[0])
            i += size
        else:
            (n,) = struct.unpack_from("<I", raw, i)
            i += 4
            vals.append([struct.unpack_from(fmt, raw, i + k * size)[0] for k in range(n)])
            i += n * size
    assert i == len(raw), (i, len(raw))
    return sig, vals


def strokes_from_notes(path):
    buf = open(path, "rb").read()
    out = []
    for rec in records(buf):
        for fn, wt, v in try_parse(rec):
            if fn != 7 or wt != 2:
                continue
            sub = try_parse(v)
            d = {}
            for f2, w2, v2 in sub:
                d.setdefault(f2, []).append(v2)
            uid = d[1][0].decode()
            sig, vals = parse_tpl(apple_decompress(d[2][0]))
            out.append((uid, sig, vals, d))
    return out


def chunk(a, n):
    return [a[k:k + n] for k in range(0, len(a), n)]


def main():
    strokes = strokes_from_notes(sys.argv[1])
    paths = []
    truth = []
    xs, ys = [], []
    for uid, sig, vals, d in strokes:
        version, arrs = vals[0], vals[1:]
        named = dict(zip(ARRAY_NAMES, arrs))
        if not named["spine_verbs"]:
            print(uid, "empty")
            continue
        print(uid, "v%d" % version, {k: len(v) for k, v in named.items()},
              "verbs", named["outline_verbs"][:12], "u9", named["unknown9"], "u8", [round(x, 3) for x in named["unknown8"][:10]])
        # outline
        starts = chunk(named["outline_starts"], 2)
        pts = iter(chunk(named["outline_points"], 2))
        arcs = iter(zip(chunk(named["unknown8"], 5), named["unknown9"]))
        verbs = iter(named["outline_verbs"])
        dstr = []
        for sp, cnt in enumerate(named["outline_counts"]):
            for _ in range(cnt):
                vb = next(verbs)
                if vb == 0:
                    x, y = starts[sp]
                    dstr.append("M%.2f %.2f" % (x, y))
                elif vb == 2:
                    (c1x, c1y), (c2x, c2y), (x, y) = next(pts), next(pts), next(pts)
                    dstr.append("C%.2f %.2f %.2f %.2f %.2f %.2f" % (c1x, c1y, c2x, c2y, x, y))
                elif vb == 3:
                    import math
                    (ax, ay, r, a1, a2), flag = next(arcs)
                    x, y = ax + r * math.cos(a2), ay + r * math.sin(a2)
                    dstr.append("A%.3f %.3f 0 0 %d %.2f %.2f" % (r, r, SWEEP, x, y))
                else:
                    raise ValueError(vb)
                xs.append(x)
                ys.append(y)
            dstr.append("Z")
        paths.append('<path d="%s" fill="black"/>' % " ".join(dstr))
        # spine
        s = named["spine_start"]
        sd = ["M%.2f %.2f" % (s[0], s[1])]
        for (cx, cy, _), (x, y, _) in chunk(chunk(named["spine_points"], 3), 2):
            sd.append("Q%.2f %.2f %.2f %.2f" % (cx, cy, x, y))
        if not CLEAN:
            paths.append('<path d="%s" fill="none" stroke="red" stroke-width="0.3"/>' % " ".join(sd))
        truth.append({"id": uid, "start": s, "points": named["spine_points"]})
    pad = 10
    x0, y0, x1, y1 = min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad
    bg = '<rect x="%f" y="%f" width="%f" height="%f" fill="white"/>' % (x0, y0, x1 - x0, y1 - y0)
    w, h = round((x1 - x0) * SCALE), round((y1 - y0) * SCALE)
    svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="%f %f %f %f" width="%d" height="%d">%s%s</svg>' % (
        x0, y0, x1 - x0, y1 - y0, w, h, bg, "".join(paths))
    open(sys.argv[2], "w").write(svg)
    if len(sys.argv) > 3:  # ground truth for testing extraction: page coords + pixel mapping
        import json
        json.dump({"origin": [x0, y0], "scale": SCALE, "width": w, "height": h, "strokes": truth},
                  open(sys.argv[3], "w"))


if __name__ == "__main__":
    main()
