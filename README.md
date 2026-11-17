# OpenPacketRouter

An open network simulator for teaching. It's built to be close to production, multi-vendor, and cheap enough that a whole class can run it at once.

Today's tools force a choice. **Packet Tracer** is easy, but it only imitates Cisco gear and can't show how failures actually unfold. **GNS3 and EVE-NG** run real vendor software, but they're hard to set up and need serious hardware. OpenPacketRouter aims for both: a fast mathematical/simulated core, with real vendor software brought in only where a student is looking. See [docs/vision.md](docs/vision.md).

## What's here now

| Path | What it is |
|---|---|
| [`web/index.html`](web/index.html) | **El Dorado Storm Lab.** A single-file, browser-based lab on the Nov 13, 2026 FAA ground stop. Students break the network and watch live storm math. Runs on Chromebooks with no install. |
| [`poc/storm-math/`](poc/storm-math/) | **Proof of concept #1.** Predicts broadcast storms from the network layout alone, checked against an independent packet simulator. |
| [`docs/vision.md`](docs/vision.md) | Design ideas: multiple detail levels, storm math, graceful-restart handoff, Git-style shared state, and vendor quirk layers. |

## Proof of concept #1: storm math

When a switch floods a broadcast, it sends a copy out every port except the one the frame came in on. The **non-backtracking matrix** `B` of the network describes exactly that. Its spectral radius **ρ** predicts what any broadcast will do:

| ρ | Meaning |
|---|---|
| 0 | No loops. Broadcasts die out. |
| 1 | A loop. Frames circulate forever, and each new broadcast adds load. |
| > 1 | A storm. Frames multiply every hop, and the growth rate comes from a renewal equation. |

**Results:** on every state of the FAA lab network, the math matched an independent packet simulator:
- the same copy counts for loop-free networks,
- 78,616 vs 78,613 frames/s for the circulating loop,
- the same doubling times (1.84 ms and 10.44 ms) for the amplifying storms,
- hotspot traffic shares within 0.1 percentage points.

The browser lab's JavaScript port reproduces the Python numbers exactly. Details and limits are in [poc/storm-math/README.md](poc/storm-math/README.md).

```bash
cd poc/storm-math
pip install numpy matplotlib pytest
python3 -m pytest -q
python3 run_report.py
```

## Using the lab with a class

- **Open it:** the file `web/index.html` works offline in any modern browser. To host it, turn on GitHub Pages for this repo (Settings → Pages → deploy from branch `main`); the lab will then be at `/web/`.
- **Missions 0–7:** briefing → healthy network → the cutover → who can see the loop → ground stop drill → fix and restore → shrink the blast radius → change plan. Each mission has a goal the lab checks automatically and a written-response question. Answers are saved only in each student's browser.
- **Companion Packet Tracer lab:** the same network with Cisco CLI is in a separate repo. The storm math here was used to correct that lab's answer key.

## Accuracy

As of Nov 17, 2026, the FAA hasn't said what protocol carried the flood. The lab models a Layer 2 broadcast storm as a teaching analogy. Link delays and speeds are illustrative, not FAA data.
