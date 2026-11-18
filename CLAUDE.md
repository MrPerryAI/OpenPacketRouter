# OpenPacketRouter

Open network simulator for teaching. **Start every session by reading docs/STATUS.md** (state, decisions,
roadmap). Vision: docs/vision.md.

## Current focus
- Work on the engine (`engine/`). Every new feature gets a frame-for-frame validation against real Linux
  (see `validate/l3/`) before it counts as done.
- The classroom lab (`web/`, `server/`, `labs/packet-tracer/`) is frozen: bug fixes only, and only when asked.

## Layout
- `web/src/` — lab source. **Edit these, never `web/index.html`.** Rebuild with `python3 tools/build_web.py`.
  `web/index.html` is page content without a document shell (the Claude artifact host and
  `server/server.js` add `<!doctype html>…`), so open it through the server, not as a file, when testing layout.
- `web/src/20-engine.js` — spanning tree + storm math. Must stay in agreement with `poc/storm-math`
  (`tests/test_parity.py` enforces it).
- `poc/storm-math/` — Python proofs of concept: validated against an independent packet simulator and against real Linux kernel bridges (`sudo python3 run_kernel.py`).
- `engine/` — the packet-level engine (switches, routers, hosts, servers). Any behavior change must keep
  `validate/l3/run_kernel_l3.py` frame-for-frame identical to Linux (needs root) and `npm test` in engine/ green.
- `server/` + `Dockerfile` + `compose.yaml` — class server (lab + shared scoreboard), no dependencies.

## Checks (all must pass before pushing)
```
python3 tools/build_web.py --check
(cd poc/storm-math && python3 -m pytest -q)
python3 -m pytest -q tests
node tests/web/smoke.mjs
(cd engine && npm test)
sudo python3 validate/l3/run_kernel_l3.py   # needs root (Linux only)
```
On a Mac, run the root checks in a privileged Linux container instead, never with sudo on the host:
`validate/docker/run.sh` (see docs/docker-validation.md). GitHub CI runs them too.

## Conventions
- Accuracy: the FAA has not published the flood's protocol. Keep the "teaching model, not a reconstruction"
  framing; label illustrative numbers as such.
- Three audience modes (plain / student / engineer): any new mission or UI text needs wording for each
  (see `WORDS`, `GLOSS`, `TRACKS` in `web/src/30-content.js`).
- The page must work without HTML-in-Canvas (CSS fallback) and without the scoreboard backends.
