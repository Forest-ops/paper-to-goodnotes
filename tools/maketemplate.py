"""Make the blank template the web app builds documents from.

Usage: python maketemplate.py <sample.goodnotes> <template.goodnotes> <template.json>

Every live stroke in the sample is erased the same way Goodnotes erases one itself:
the header gets the deleted flag (3: 1) and a bumped version counter, and the body gets
an empty point list, field 14: 1 and the same bumped version.

template.json is what the web app loads: every zip entry (base64) plus the values
needed to append new stroke records (next sequence number, template records).
"""
import base64
import json
import sys

from gnwrite import STROKE_SIG, Doc, apple_compress, enc_fields, enc_tpl, get, replace, try_parse

EMPTY_STROKE = [2, [], [], [], [], [], [], [], [], [], []]


def insert_after(fields, after_fn, new):
    out = []
    for f in fields:
        out.append(f)
        if f[0] == after_fn:
            out.append(new)
    return out


def main():
    src, out_gn, out_json = sys.argv[1:4]
    d = Doc(src)
    live = list(d.strokes())
    assert live, "sample has no strokes to use as a template"
    tmpl_hdr = d.recs[live[0][0]]
    tmpl_body = get(d.recs[live[0][1]], 7)

    for h, b, _, _ in live:
        ver = try_parse(get(d.recs[h], 2))
        ver = enc_fields([(1, 0, get(ver, 1) + 1), (2, 0, get(ver, 2))])
        hdr = replace(d.recs[h], 2, 2, ver)
        d.recs[h] = insert_after(hdr, 2, (3, 0, 1))
        bf = try_parse(get(d.recs[b], 7))
        bf = replace(bf, 2, 2, apple_compress(enc_tpl(STROKE_SIG, EMPTY_STROKE)))
        bf = insert_after(bf, 9, (14, 0, 1))
        bf = replace(bf, 15, 2, ver)
        d.recs[b] = [(7, 2, enc_fields(bf))]
    assert not list(d.strokes()), "strokes left alive"
    d.save(out_gn)

    # bundle for the web app
    d2 = Doc(out_gn)
    meta = {
        "notesName": d2.notes_name,
        "nextSeq": max(get(f, 9) or 0 for f in d2.recs) + 1,
        "strokeHeader": base64.b64encode(enc_fields(tmpl_hdr)).decode(),
        "strokeBody": base64.b64encode(tmpl_body).decode(),
        # canvas spot where the sample's ink was, so Goodnotes opens near the new ink
        "origin": [250780.0, 250880.0],
        "thumbnailName": "thumbnail.jpg",
    }
    entries = [{"name": n, "data": base64.b64encode(d2.files[n]).decode()} for n in d2.names]
    json.dump({"meta": meta, "entries": entries}, open(out_json, "w"))
    print("erased %d strokes; next seq %d" % (len(live), meta["nextSeq"]))


if __name__ == "__main__":
    main()
