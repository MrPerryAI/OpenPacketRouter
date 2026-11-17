# OpenPacketRouter

An open network simulator for teaching. It's built to be close to production, multi-vendor, and cheap enough that a whole class can run it at once.

Today's tools force a choice. **Packet Tracer** is easy, but it only imitates Cisco gear and can't show how failures actually unfold. **GNS3 and EVE-NG** run real vendor software, but they're hard to set up and need serious hardware. OpenPacketRouter aims for both: a fast mathematical/simulated core, with real vendor software brought in only where a student is looking. See [docs/vision.md](docs/vision.md).

## What's here now

| Path | What it is |
|---|---|
| [`web/index.html`](web/index.html) | **El Dorado Storm Lab.** A single-file, browser-based lab on the Nov 13, 2026 FAA ground stop, with three audience modes: Plain English (a 4-chapter story), Student (8 guided missions with self-checking steps, hints, glossary, predictions and a coach) and Engineer. Uses the HTML-in-Canvas API (Edge/Chrome 157+) to paint real HTML device cards into the animated map; other browsers get a simpler fallback. |
| [`poc/storm-math/`](poc/storm-math/) | **Proofs of concept #1 and #2.** Predicts broadcast storms from the network layout alone. Checked against an independent packet simulator (#1) and against real Linux kernel bridges (#2). |
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
- **Browser:** use Microsoft Edge or Chrome 157 or newer for the full effects (HTML-in-Canvas). Other browsers still work, with simpler effects.
- **Modes:** students pick one in the intro, or switch from the top bar. *Plain English* is a short story for anyone. *Student* gives first-year students key ideas, self-checking steps with "Show me" highlights, hints, tap-to-define glossary terms, a forced prediction before the key cable, and a coach that explains each event. *Engineer* removes the scaffolding and shows the matrix.
- **Student missions 1–8:** briefing → healthy network → the cutover → who can see the loop → ground stop drill → fix and restore → shrink the blast radius → change plan. Written answers are saved only in each student's browser.
- **Score report and scoreboard:** students earn points for steps, finished missions, predictions, written answers and fast ground stop containment, and lose a few points per hint. **Score report** in the top bar shows the breakdown and copies it as text. The class scoreboard works two ways:
  - **Published Claude link:** scores are shared live through the page's own storage. Students must be signed in to Claude and given **Contributor** ("can use") access from the Share menu; view-only students can see the board but not post. Names show as first name and last initial. The teacher (owner) gets a *Clear scoreboard* button.
  - **Class server (no Claude accounts needed):** run it on any computer on the school network, such as a Mac with Docker, and students open `http://<that-computer's-IP>:8080`. Each student types a display name.

### Run the class server on a Mac with Docker

```bash
git clone https://github.com/MrPerryAI/OpenPacketRouter.git
```

```bash
cd OpenPacketRouter
```

```bash
TEACHER_KEY=pick-a-secret docker compose up -d --build
```

Find the Mac's IP address under System Settings → Network, then give students `http://<IP>:8080`. Scores persist in a Docker volume across restarts. To clear the board:

```bash
curl -X DELETE "http://localhost:8080/api/scores?key=pick-a-secret"
```

To stop the server:

```bash
docker compose down
```

The school network must allow student devices to reach the Mac on port 8080, and macOS may ask to allow incoming connections the first time. Anyone on the network who opens the page can post a score, so treat the board as a classroom game, not a gradebook.

- **Companion Packet Tracer lab:** the same network with Cisco CLI is in a separate repo. The storm math here was used to correct that lab's answer key.

## Accuracy

As of Nov 17, 2026, the FAA hasn't said what protocol carried the flood. The lab models a Layer 2 broadcast storm as a teaching analogy. Link delays and speeds are illustrative, not FAA data.
