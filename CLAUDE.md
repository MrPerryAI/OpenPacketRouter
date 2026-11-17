# OpenPacketRouter

Open network simulator for teaching. Today it holds the El Dorado Storm Lab (a browser lab on the
Nov 13, 2026 FAA ground stop) and the storm-math proof of concept. See README.md and docs/vision.md.

## Layout
- `web/src/` — lab source. **Edit these, never `web/index.html`.** Rebuild with `python3 tools/build_web.py`.
  `web/index.html` is page content without a document shell (the Claude artifact host and
  `server/server.js` add `<!doctype html>…`), so open it through the server, not as a file, when testing layout.
- `web/src/20-engine.js` — spanning tree + storm math. Must stay in agreement with `poc/storm-math`
  (`tests/test_parity.py` enforces it).
- `poc/storm-math/` — Python proof of concept, validated against an independent packet simulator.
- `server/` + `Dockerfile` + `compose.yaml` — class server (lab + shared scoreboard), no dependencies.

## Checks (all must pass before pushing)
```
python3 tools/build_web.py --check
(cd poc/storm-math && python3 -m pytest -q)
python3 -m pytest -q tests
node tests/web/smoke.mjs
```

## Conventions
- Accuracy: the FAA has not published the flood's protocol. Keep the "teaching model, not a reconstruction"
  framing; label illustrative numbers as such.
- Three audience modes (plain / student / engineer): any new mission or UI text needs wording for each
  (see `WORDS`, `GLOSS`, `TRACKS` in `web/src/30-content.js`).
- The page must work without HTML-in-Canvas (CSS fallback) and without the scoreboard backends.
