# Paper to Goodnotes

An iPad web app (PWA) that photographs handwritten notes and turns them into a `.goodnotes`
file with real, editable ink strokes.

## Layout

| Path | What it is |
|---|---|
| `app/` | The web app: `index.html`, `app.js`, `worker.js`, manifest, service worker, icons, `template.json` |
| `src/page.js` | Find the sheet of paper in a photo and straighten it (perspective correction) |
| `src/extract.js` | Page → strokes: even out lighting, subtract ruled lines, mask binder holes, two-level ink threshold, thinning, stroke tracing |
| `src/goodnotes.js` | Strokes → `.goodnotes` (protobuf, point data, outline, zip) with a safety validator |
| `src/layout.js` | Photo pixels → Goodnotes page points |
| `tools/` | Python tools for reverse-engineering and checking files (`gndump`, `gnstrokes`, `gnwrite`, `maketemplate`) |
| `docs/goodnotes-format.md` | What is known about the file format |
| `test/` | `extract-test.mjs` (accuracy against known strokes), `photo-test.mjs` / `photo-build.mjs` (real photos in `samples/real/`, not committed), `build-test.mjs` (end to end) |

## Run locally

```bash
python -m http.server 8765
```

Then open http://localhost:8765/app/. Sharing to Goodnotes and offline mode need HTTPS,
so to use it on the iPad, host it on an HTTPS site such as GitHub Pages.

## Tests

```bash
npm install
```

```bash
node test/extract-test.mjs --photo
```

```bash
node test/build-test.mjs
```

## Safety

A malformed stroke once made Goodnotes crash on every launch. `validateStroke` (JS) and
`validate_stroke` (Python) reject anything that doesn't match real Goodnotes stroke data,
and no file is written unless every stroke passes. Keep it that way.
