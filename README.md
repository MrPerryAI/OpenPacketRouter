# OpenPacketRouter

An open network simulator for teaching. It's built to be close to production, multi-vendor, and cheap enough that a whole class can run it at once.

Today's tools force a choice. **Packet Tracer** is easy, but it only imitates Cisco gear and can't show how failures actually unfold. **GNS3 and EVE-NG** run real vendor software, but they're hard to set up and need serious hardware. OpenPacketRouter aims for both: a fast mathematical/simulated core, with real vendor software brought in only where a student is looking. See [docs/vision.md](docs/vision.md).

## Quick start

You need Node 18 or newer. There's nothing to install and no build step.

```bash
git clone https://github.com/MrPerryAI/OpenPacketRouter.git
cd OpenPacketRouter
```

**Run a lab network** and read what every switch and router decided, frame by frame:

```bash
node engine/bin/openpacketrouter.mjs run examples/loop-with-stp/spec.json examples/loop-with-stp/actions.json --text
```

Leave off `--text` for JSON (frame counts per cable). `openpacketrouter check spec.json` checks your own network, and
`openpacketrouter actions` lists what a lab can do (ping, traceroute, DNS, TCP, cable cuts, waits, table dumps).
Networks are JSON or YAML; the format is in [docs/spec-format.md](docs/spec-format.md).

**Use a device's command line**. Every router and switch in a spec has one:

```bash
node cli/bin/opr-cli.mjs examples/routed-lan-dns/spec.json R1 -c "show ip route"
node cli/bin/opr-cli.mjs examples/routed-lan-dns/spec.json R1          # interactive: ? for help, Tab completes
```

Add `| json` to a show command for machine-readable output. `--render linux` (or `frr`, `openwrt`) prints the
same configuration for real Linux, FRRouting or OpenWrt. All commands are in [docs/cli-reference.md](docs/cli-reference.md).

**Open the browser studio** to see the map, play back frames, cut cables, edit the topology and use the consoles:

```bash
python3 -m http.server 8640        # from the repository root, then open http://localhost:8640/studio/
```

**Labs for a class**: [examples/](examples/README.md) has ready-to-run networks (spanning tree, VLANs, inter-VLAN
routing, DHCP, NAT, ACLs, RIP, OSPF, LACP, port security, TCP and more). Each one has a student guide in
[docs/labs/](docs/labs/README.md).

### How we know it's right

Every feature is checked against real software, frame for frame and cable by cable. CI builds the same network out
of Linux network namespaces, bridges, nftables, tc, dnsmasq, lldpd, mstpd and FRRouting, runs the same actions
there, and compares every frame on every cable plus the resulting tables with the engine. A feature counts as done
only when they match. The validators are in [validate/](validate/), and the current list is in
[docs/STATUS.md](docs/STATUS.md).

## What's here now

| Path | What it is |
|---|---|
| [`cli/`](cli/) | **Device CLI.** Modes, `?` help, Tab completion, `| json`, and an OpenConfig-shaped model with engine, Linux, FRRouting and OpenWrt backends. |
| [`studio/`](studio/) | **Studio.** The browser front end: topology editor, frame playback, device panels and consoles. |
| [`examples/`](examples/) | **Example labs** that run with the CLI and the studio, each with a student guide in [`docs/labs/`](docs/labs/). |
| [`validate/`](validate/) | **Validators.** The engine against real Linux and FRRouting, run in CI. |
| [`web/index.html`](web/index.html) | **El Dorado Storm Lab.** A single-file, browser-based lab on the Nov 13, 2026 FAA ground stop, with three audience modes: Plain English (a 4-chapter story), Student (8 guided missions with self-checking steps, hints, glossary, predictions and a coach) and Engineer. Uses the HTML-in-Canvas API (Edge/Chrome 157+) to paint real HTML device cards into the animated map; other browsers get a simpler fallback. |
| [`poc/storm-math/`](poc/storm-math/) | **Proofs of concept #1 and #2.** Predicts broadcast storms from the network layout alone. Checked against an independent packet simulator (#1) and against real Linux kernel bridges (#2). |
| [`engine/`](engine/) | **The engine.** Packet-level simulator: switches (spanning tree and RSTP, VLANs, LACP, port security, storm control), routers (static, RIP, OSPF, ACLs, NAT, DHCP and relay), hosts and servers (ARP, IPv4, ICMP, UDP, DNS, TCP, LLDP), link rates and queues, with a plain-English reason for every decision. |
| [`validate/l3/`](validate/l3/) | **Proof of concept #3.** The engine vs real Linux routers, clients and servers: 12 of 12 actions match frame for frame, cable by cable ([results](validate/l3/results.md)). |
| [`labs/packet-tracer/`](labs/packet-tracer/) | Archived Packet Tracer lab for the same event: handouts, paste-in CLI configs, PTBuilder build scripts, worksheet, teacher guide. |
| [`docs/STATUS.md`](docs/STATUS.md) | Current state, decisions, and the engine roadmap. Start here. |
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

## License

Apache License 2.0: see [LICENSE](LICENSE) and [NOTICE](NOTICE).
