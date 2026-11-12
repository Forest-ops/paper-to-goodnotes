# .goodnotes file format notes (reverse-engineered)

Based on one Goodnotes 6 whiteboard export (`samples/testing.goodnotes`, schema version 35).
Nothing here is official; verify against new samples when Goodnotes updates.

## Container

A standard ZIP (deflate) with:

| Entry | Contents |
|---|---|
| `schema.pb` | `{1: 35}`: schema version |
| `document.info.pb` | `{1: 4}` |
| `index.notes.pb` | maps page/notes UUID -> `notes/<uuid>` |
| `index.search.pb` | maps page UUID -> `search/<uuid>` |
| `notes/<uuid>` | **page content: strokes, text, shapes** |
| `search/<uuid>` | handwriting-recognition index (words + stroke UUIDs) |
| `index.events.pb` | document title, page list, page settings |
| `index.attachments.pb` | empty when there are no images/PDFs |
| `thumbnail.jpg` | preview |

## Record files

Every `.pb` file is a sequence of **varint-length-prefixed protobuf messages**.
`notes/<uuid>` alternates a *header* record and a *body* record per element:

Header: `1` UUID string, `2 {1: counter, 2: random u32}` version, `3: 1` = **deleted**
(tombstone; absent on live elements), `8` document id (constant), `9` creation sequence
(increasing), `14: 5381`, `16` element type.

Element types: `24` = ink stroke (body field `7`), `31` = connector (body field `22`),
`35` = text/mind-map node (body field `21`).

## Ink stroke body (field 7)

`1` UUID, `2` point data (below), `3: 1`, `4 {1:r 2:g 3:b 4:a}` colour as floats
(zero fields omitted, so black = `{4: 1.0}`), `7 {1 {1: 5, 2: u32}}` (unknown, copied),
`15` same version as header, `21: 24`.

## Point data

Apple compression framework LZ4 framing: `bv41` + u32 raw size + u32 block size + LZ4 block,
repeated, ending with `bv4$`. A literal-only LZ4 block is valid, so writing needs no real compressor.

Decompressed it is a self-describing "tpl" blob:

```
"tpl\0"  u32 total_length  "vA(v)A(u)A(u)A(v)A(v)A(u)A(u)A(u)A(u)A(v)\0"  values...
```

`v` = u16, `u` = f32, `A(x)` = u32 count followed by that many items. Values in order:

| # | Type | Meaning |
|---|---|---|
| 0 | u16 | version = 2 |
| 1 | u16[] | centerline verbs: 0 = moveTo, 1 = quadTo |
| 2 | f32[3] | centerline start (x, y, half-width) |
| 3 | f32[] | centerline quad points: (control xyw, end xyw) per quadTo |
| 4 | u16[] | outline: verb count per sub-path (one sub-path per centerline segment) |
| 5 | u16[] | outline verbs: 0 = moveTo, 2 = cubicTo (3 points), 3 = round-cap arc |
| 6 | f32[] | outline sub-path start points (x, y) |
| 7 | f32[] | always empty so far |
| 8 | f32[] | outline cubic points (x, y) |
| 9 | f32[] | arcs, 5 per arc: center x, y, radius, start angle, end angle (radians; drawn with decreasing angle) |
| 10 | u16[] | one flag per arc, always 1 |

Coordinates are page points; the whiteboard canvas is centred near (250000, 250000).

Each centerline segment's outline is a closed capsule: moveTo left side, cubics along the
left offset, arc cap at the segment end, cubics back along the right offset, arc cap at the start.
`tools/gnwrite.py` `build_stroke()` generates this.

## Tools

- `tools/gndump.py <file>`: dump any record file as a protobuf tree
- `tools/gnstrokes.py <notes-file> <out.svg>`: render strokes to SVG
- `tools/gnwrite.py <sample.goodnotes> <out-dir>`: build the import test files
