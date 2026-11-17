# Project status and hand-off

*Last updated 17 Nov 2026. Read this first in a new session. CLAUDE.md has the rules; this file has the state.*

## Direction

**Focus: the engine (`engine/`).** The goal is an open, production-close, multi-vendor network simulator for teaching. Its core idea is mixed detail levels: cheap models for the background, with real software (Linux, FRRouting, vendor images) swapped in where a student is looking. See `docs/vision.md`.

**The classroom lab is frozen.** `web/` (El Dorado Storm Lab) and `labs/packet-tracer/` are finished and in use. Fix bugs only if asked; don't add features. The lab will later be rebuilt on top of the engine.

## What exists

| Path | What | Verified how |
|---|---|---|
| `engine/` | Packet-level simulator in plain JS (ES modules, no deps): learning switches with **802.1D spanning tree and 802.1Q VLANs** (access, trunk, native VLAN; router-on-a-stick subinterfaces); routers (longest-prefix match, TTL, ICMP time exceeded / net & host unreachable); hosts and servers (ARP, ICMP echo, UDP, DNS); actions `ping`, `traceroute`, `dns`, `udpRequest`; every decision logged in plain English (`net.trace`). | `engine/test/` (20 unit tests); `validate/l3/run_kernel_l3.py`: **12/12 actions match real Linux frame for frame, cable by cable**, across a healthy routed network, a routing loop, and a missing return route; `validate/l2/run_kernel_l2.py`: spanning tree and VLANs vs kernel bridges, see below. Both run in CI on GitHub (sudo). |
| `validate/l3/` | Specs (`fti-routed.json`, `fti-loop.json`, `fti-noreturn.json`) + actions, the Linux harness, `probe.py`, `dns_server.py`, `results.md`. | — |
| `validate/l2/` | Spanning tree and VLAN specs + timed actions, the Linux harness (mirrors the engine's MACs, priorities, costs, timers, port numbers and VLANs into kernel bridges with `stp_state 1` / `vlan_filtering 1`), `sniff.py` (per-namespace frame classifier, cross-checked against tx counters), `results.md`. Compares port states/roles, BPDU contents and which cables carry them, and data + tagged frames cable by cable, at the same moments during convergence and after cables are cut. | **32/32 timed actions match** (20 spanning tree, 12 VLAN) in CI on GitHub's kernel. STP specs also pass locally; VLAN specs need 802.1Q, which the cloud kernel lacks, so they run in CI only (`REQUIRE_VLAN=1`). |
| `poc/storm-math/` | Broadcast-storm math: ρ (spectral radius of the non-backtracking matrix) classifies loops as tree / circulating / amplifying; a renewal equation gives growth rate and hotspot links. | vs an independent packet simulator (16 tests), and vs **real Linux kernel bridges** (`run_kernel.py`: exact copy counts, circulating rates within 4%, storm growth matches the simulator before cables fill). The kernel test is opt-in and needs root. |
| `web/` | The Storm Lab (frozen). Source in `web/src/`, built by `tools/build_web.py`. It has its own small switch-only engine (`web/src/20-engine.js`) kept in parity with `poc/storm-math` by `tests/test_parity.py`. | `tests/web/smoke.mjs` (Playwright, with and without HTML-in-Canvas, plus the class scoreboard) |
| `server/`, `Dockerfile`, `compose.yaml` | Class server for the lab (scoreboard without Claude accounts). | smoke test |
| `labs/packet-tracer/` | Archived Packet Tracer lab (handouts, CLI configs, PTBuilder scripts, worksheet, teacher guide). | — |

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

The last command needs root, iproute2 and `unshare`. In a cloud session, install `iproute2` with apt first. CI runs all of these on every push (`.github/workflows/ci.yml`).

## Decisions made

- **Language:** plain JavaScript for the engine, so it runs in the browser and Node with no build. Rust/WASM is deferred until speed matters.
- **Validation method:** every engine feature is checked against real Linux by building the same network from namespaces and comparing results **and per-cable frame counts**. Linux settings that change which frames appear are pinned to what the engine models: ICMP redirects off, ICMP rate limit off, rp_filter off, IPv6 off. Caches are flushed before each action. A feature isn't done until it matches.
- **Determinism:** the event queue breaks ties by sequence number; the same spec and actions always give the same frames.
- **Accuracy framing (lab):** the FAA hasn't published the flood's protocol. The lab is a teaching analogy (Layer 2 broadcast storm).

## Not modeled yet (engine)

RSTP/MSTP/PVST+ (one classic 802.1D tree for all VLANs, like Linux), TCP, DHCP, dynamic routing (OSPF/BGP), link capacity and queues, IPv6, NAT, firewalls/ACLs, multi-vendor CLI.

## Roadmap (engine), suggested order

1. ~~**Spanning tree + VLANs in `engine/`.**~~ Done (Nov 2026): `engine/src/switch.js`, validated in `validate/l2/`. Possible follow-ups: RSTP (Linux only does it in user space, via mstpd), per-VLAN trees (needs a non-Linux reference, e.g. a vendor image).
2. **Storm math inside the engine:** compute ρ/reach from the engine's live topology (the "loop-risk score" for the detail-level scheduler).
3. **Link capacity, queues, drops**, so storms and congestion have physical limits. Validate with the kernel's `tbf` qdisc (`netem` isn't available in the cloud kernel).
4. **DHCP, then TCP** (handshake, retransmission). Validate against Linux.
5. **OSPF.** Validate against FRRouting in namespaces.
6. **Mixed detail levels:** swap one device between engine model and a real Linux namespace mid-traffic (the handoff experiment in `docs/vision.md`).
7. **Spec format and CLI:** a stable JSON/YAML network spec, `openpacketrouter run spec.json actions.json`, and trace output for tools and agents.

## Environment notes (cloud sessions)

- Root works; `unshare -n -m` gives an isolated network namespace. `ip netns` needs a private `/run` (`mount -t tmpfs none /run` inside the unshare).
- The cloud kernel has no IPv6 and no `netem`. `tbf`, `htb` and `pfifo` exist. No 802.1Q either (`CONFIG_VLAN_8021Q` off, so no VLAN-aware bridges or VLAN devices) and no tc `flower`/`matchall`: VLAN validation runs on GitHub's runner kernel only. Kernel STP works in namespaces.
- Kernel STP facts the engine relies on (checked here): only the root sends hellos (others relay); `ip -j -d link` misreports a bridge's `root_id`, so the harness reads sysfs; port ids are `priority/4 << 10 | port_no`; hello/hold timers are rounded to whole seconds of uptime, so BPDU *counts* are compared ±1 while everything else is exact.
- `tests/web/smoke.mjs` fails one check locally ("HTML-in-Canvas detected correctly" in the off run) even on unchanged `main`: the local Chromium build differs from CI's. CI passes it.
- Global Playwright is available in Node via `createRequire` (see `tests/web/smoke.mjs`). Chromium 153 locally; HTML-in-Canvas needs the `--enable-blink-features=CanvasDrawElement` flag there (Edge/Chrome 157+ have it by default).
- The session can push to `MrPerryAI/OpenPacketRouter` only (no new repos).
