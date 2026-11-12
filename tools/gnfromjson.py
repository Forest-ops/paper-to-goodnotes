"""Add strokes from a JSON file ([[ [x, y, halfwidth], ... ], ...] in page points) to a .goodnotes copy.

Usage: python gnfromjson.py <sample.goodnotes> <strokes.json> <out.goodnotes> [dx dy]
Every stroke is checked with validate_stroke() before saving.
"""
import json
import sys

from gnwrite import Doc, build_stroke, validate_stroke


def main():
    src, js, out = sys.argv[1:4]
    dx, dy = (float(sys.argv[4]), float(sys.argv[5])) if len(sys.argv) > 5 else (0.0, 0.0)
    d = Doc(src)
    tmpl = list(d.strokes())[0]
    n = 0
    for pts in json.load(open(js)):
        if len(pts) < 2:
            continue
        vals = build_stroke([(x + dx, y + dy, w) for x, y, w in pts])
        validate_stroke(vals)
        d.add_stroke(tmpl[0], tmpl[1], vals)
        n += 1
    d.save(out)
    for t in Doc(out).strokes():
        validate_stroke(t[3])
    print("added %d strokes -> %s" % (n, out))


if __name__ == "__main__":
    main()
