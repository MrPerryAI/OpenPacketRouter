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
- `cli/` — the device CLI (modes, `?`, Tab, `| json`, data-driven command files, OpenConfig-shaped model, engine
  backend; Linux/FRR/OpenWrt renderers). Design: `docs/cli-design.md`. Help text is our own: never copy Cisco IOS
  or FRRouting (GPL) code or text. A new spec key needs a command, or `cli/test/roundtrip.test.js` fails.
- `studio/` — the browser front end for the engine (plain ES modules, no build step): serve the repository root
  (`npm run studio`) and open http://localhost:8640/studio/. Smoke test: `tests/studio/smoke.mjs`.
- `server/` + `Dockerfile` + `compose.yaml` — class server (lab + shared scoreboard), no dependencies.

## Checks (all must pass before pushing)
```
python3 tools/build_web.py --check
(cd poc/storm-math && python3 -m pytest -q)
python3 -m pytest -q tests
node tests/web/smoke.mjs
node tests/studio/smoke.mjs
(cd engine && npm test)
(cd cli && npm test)
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
