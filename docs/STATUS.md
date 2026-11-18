# Project status and hand-off

*Last updated 18 Nov 2026. Read this first in a new session. CLAUDE.md has the rules; this file has the state.*

## Direction

**Focus: the engine (`engine/`).** The goal is an open, production-close, multi-vendor network simulator for teaching. Its core idea is mixed detail levels: cheap models for the background, with real software (Linux, FRRouting, vendor images) swapped in where a student is looking. See `docs/vision.md`.

**The classroom lab is frozen.** `web/` (El Dorado Storm Lab) and `labs/packet-tracer/` are finished and in use. Fix bugs only if asked; don't add features. The lab will later be rebuilt on top of the engine.

## What exists

| Path | What | Verified how |
|---|---|---|
| `engine/` | Packet-level simulator in plain JS (ES modules, no deps): learning switches; routers (longest-prefix match, TTL, ICMP time exceeded / net & host unreachable); hosts and servers (ARP, ICMP echo, UDP, DNS); actions `ping`, `traceroute`, `dns`, `udpRequest`; every decision logged in plain English (`net.trace`). | `engine/test/` (10 unit tests) and `validate/l3/run_kernel_l3.py`: **12/12 actions match real Linux frame for frame, cable by cable**, across a healthy routed network, a routing loop, and a missing return route. Runs in CI on GitHub (sudo). |
| `validate/l3/` | Specs (`fti-routed.json`, `fti-loop.json`, `fti-noreturn.json`) + actions, the Linux harness, `probe.py`, `dns_server.py`, `results.md`. | — |
| `poc/storm-math/` | Broadcast-storm math: ρ (spectral radius of the non-backtracking matrix) classifies loops as tree / circulating / amplifying; a renewal equation gives growth rate and hotspot links. | vs an independent packet simulator (16 tests), and vs **real Linux kernel bridges** (`run_kernel.py`: exact copy counts, circulating rates within 4%, storm growth matches the simulator before cables fill). The kernel test is opt-in and needs root. |
| `web/` | The Storm Lab (frozen). Source in `web/src/`, built by `tools/build_web.py`. It has its own small switch-only engine (`web/src/20-engine.js`) kept in parity with `poc/storm-math` by `tests/test_parity.py`. | `tests/web/smoke.mjs` (Playwright, with and without HTML-in-Canvas, plus the class scoreboard) |
| `server/`, `Dockerfile`, `compose.yaml` | Class server for the lab (scoreboard without Claude accounts). | smoke test |
| `labs/packet-tracer/` | Archived Packet Tracer lab (handouts, CLI configs, PTBuilder scripts, worksheet, teacher guide). | — |
| `validate/docker/` | Mac recipe for the root checks: `run.sh` runs the kernel validators inside a privileged Linux container (`l3`, `storm`, `full`). Steps and troubleshooting in `docs/docker-validation.md`. | Runs the same checks as CI; CI (Ubuntu, sudo) is the merge reference. |

Published lab (private, owner shares it): https://claude.ai/artifact/HovFu2jwbZodRPv5bNzUH4. It's published from `web/index.html` with capabilities `db` (rules: `scores` read view/write owner; `scores/{self}` write interact) and `user` (scope profile). Pass that URL to republish.

## How to check everything

```bash
python3 tools/build_web.py --check
(cd poc/storm-math && python3 -m pytest -q)
python3 -m pytest -q tests
node tests/web/smoke.mjs
(cd engine && npm test)
sudo python3 validate/l3/run_kernel_l3.py
```

The last command needs root, iproute2 and `unshare`. In a cloud session, install `iproute2` with apt first.

**On a Mac, do not run the last command with `sudo` on the host.** Use the privileged Linux container instead: `validate/docker/run.sh` runs the kernel checks (`l3`, `storm`, or `full`). The steps and troubleshooting are in [docs/docker-validation.md](docker-validation.md). CI runs all of these on every push (`.github/workflows/ci.yml`) and is the reference result for merging.

## Decisions made

- **Language:** plain JavaScript for the engine, so it runs in the browser and Node with no build. Rust/WASM is deferred until speed matters.
- **Validation method:** every engine feature is checked against real Linux by building the same network from namespaces and comparing results **and per-cable frame counts**. Linux settings that change which frames appear are pinned to what the engine models: ICMP redirects off, ICMP rate limit off, rp_filter off, IPv6 off. Caches are flushed before each action. A feature isn't done until it matches.
- **Determinism:** the event queue breaks ties by sequence number; the same spec and actions always give the same frames.
- **Accuracy framing (lab):** the FAA hasn't published the flood's protocol. The lab is a teaching analogy (Layer 2 broadcast storm).

## Not modeled yet (engine)

Spanning tree, VLANs/trunks, TCP, DHCP, dynamic routing (OSPF/BGP), link capacity and queues, IPv6, NAT, firewalls/ACLs, multi-vendor CLI.

## Roadmap (engine), suggested order

1. **Spanning tree + VLANs in `engine/`.** Port the STP logic from `web/src/20-engine.js` (root bridge, root/designated/blocked ports, BPDU pass/drop) into a real BPDU-exchanging implementation. Validate port roles against the kernel bridge with `stp_state 1`, and VLAN trunks against kernel VLAN-aware bridges.
2. **Storm math inside the engine:** compute ρ/reach from the engine's live topology (the "loop-risk score" for the detail-level scheduler).
3. **Link capacity, queues, drops**, so storms and congestion have physical limits. Validate with the kernel's `tbf` qdisc (`netem` isn't available in the cloud kernel).
4. **DHCP, then TCP** (handshake, retransmission). Validate against Linux.
5. **OSPF.** Validate against FRRouting in namespaces.
6. **Mixed detail levels:** swap one device between engine model and a real Linux namespace mid-traffic (the handoff experiment in `docs/vision.md`).
7. **Spec format and CLI:** a stable JSON/YAML network spec, `openpacketrouter run spec.json actions.json`, and trace output for tools and agents.

## Environment notes (cloud sessions)

- Root works; `unshare -n -m` gives an isolated network namespace. `ip netns` needs a private `/run` (`mount -t tmpfs none /run` inside the unshare).
- The cloud kernel has no IPv6 and no `netem`. `tbf`, `htb` and `pfifo` exist.
- Global Playwright is available in Node via `createRequire` (see `tests/web/smoke.mjs`). Chromium 153 locally; HTML-in-Canvas needs the `--enable-blink-features=CanvasDrawElement` flag there (Edge/Chrome 157+ have it by default).
- The session can push to `MrPerryAI/OpenPacketRouter` only (no new repos).
