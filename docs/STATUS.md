# Project status and hand-off

*Last updated 19 Nov 2026. Read this first in a new session. CLAUDE.md has the rules; this file has the state.*

## Direction

**Focus: the engine (`engine/`).** The goal is an open, production-close, multi-vendor network simulator for teaching. Its core idea is mixed detail levels: cheap models for the background, with real software (Linux, FRRouting, vendor images) swapped in where a student is looking. See `docs/vision.md`.

**The classroom lab is frozen.** `web/` (El Dorado Storm Lab) and `labs/packet-tracer/` are finished and in use. Fix bugs only if asked; don't add features. The lab will later be rebuilt on top of the engine.

## What exists

| Path | What | Verified how |
|---|---|---|
| `engine/` | Packet-level simulator in plain JS (ES modules, no deps): learning switches; routers (longest-prefix match, TTL, ICMP time exceeded / net & host unreachable); hosts and servers (ARP, ICMP echo, UDP, DNS); actions `ping`, `traceroute`, `dns`, `udpRequest`; every decision logged in plain English (`net.trace`). | `engine/test/` (61 tests: engine, spec format, storm math, spanning tree, VLANs, link shaping, DHCP, TCP, CLI report, example labs) and `validate/l3/run_kernel_l3.py`: **12/12 actions match real Linux frame for frame, cable by cable**, across a healthy routed network, a routing loop, and a missing return route. Runs in CI on GitHub (sudo). |
| `validate/l3/` | Specs (`fti-routed.json`, `fti-loop.json`, `fti-noreturn.json`) + actions, the Linux harness, `probe.py`, `dns_server.py`, `results.md`. | — |
| `poc/storm-math/` | Broadcast-storm math: ρ (spectral radius of the non-backtracking matrix) classifies loops as tree / circulating / amplifying; a renewal equation gives growth rate and hotspot links. | vs an independent packet simulator (16 tests), and vs **real Linux kernel bridges** (`run_kernel.py`: exact copy counts, circulating rates within 4%, storm growth matches the simulator before cables fill). The kernel test is opt-in and needs root. |
| `web/` | The Storm Lab (frozen). Source in `web/src/`, built by `tools/build_web.py`. It has its own small switch-only engine (`web/src/20-engine.js`) kept in parity with `poc/storm-math` by `tests/test_parity.py`. | `tests/web/smoke.mjs` (Playwright, with and without HTML-in-Canvas, plus the class scoreboard) |
| `server/`, `Dockerfile`, `compose.yaml` | Class server for the lab (scoreboard without Claude accounts). | smoke test |
| `labs/packet-tracer/` | Archived Packet Tracer lab (handouts, CLI configs, PTBuilder scripts, worksheet, teacher guide). | — |
| `engine/src/spec.js`, `engine/bin/openpacketrouter.mjs`, `docs/spec-format.md` | Network spec v1 (one JSON file for the network, one for the actions) and the `openpacketrouter` CLI: `check`, `run [--trace] [--compact] [--text]`, `actions`, `schema`. `--text` prints a readable report instead of JSON. Same files feed the engine and the Linux validators. JSON only; YAML not done. A JSON Schema of the structure is in `engine/spec.schema.json` for editors and other tools. | `engine/test/spec.test.js` and `check` on `validate/l3/fti-routed.json` (exit 0). `check` warns on interface names the Linux validators can't build (`ip link` keywords such as `a` or `m`). `tests/test_spec_schema.py` (pytest, CI) checks the schema; not run locally. The spec is the same network `run_kernel_l3.py` builds, so it inherits that validation. |
| `engine/src/storm.js` | Storm math on the engine's live topology (roadmap step 2): ρ, regime (tree / circulating / amplifying), growth rate and doubling time, loop edges and reach. It reads the network and sends no frames. It honours link up/down, blocked switch ports and per-link capacity, using a shaped link's rate when it has a shaper. For circulating loops it also gives the steady frames per second on every cable after one broadcast (`stormRates`). | `tests/test_engine_storm.py` checks every `poc/storm-math` scenario for an exact match against the engine, including the steady rates (pytest, CI); `engine/test/storm.test.js`. Not run locally: pytest is not installed in this sandbox. |
| `engine/src/stp.js`, VLAN support in `engine/src/network.js`, `validate/l2/` | Spanning tree (802.1D with real BPDUs: root bridge, root/designated/blocked ports, timers, max-age expiry) and VLANs (access and trunk ports, native VLAN, per-VLAN MAC tables), roadmap step 1. Set on switches with the `stp` and `vlans` keys in a spec. | `validate/l2/run_kernel_l2.py` compares port roles and states, and VLAN forwarding, against Linux kernel bridges (`stp_state 1`, VLAN-aware bridges): 18 checks, all matching in `validate/l2/results.md`. The checks include spanning-tree tie-breaks (parallel cables, equal-cost paths, cables cut and restored). Runs in CI (sudo); `engine/test/stp.test.js` and `vlan.test.js`. Not run locally: no root here. The `stp` and `vlans` keys are registered in the spec validator (PR #12), so the CLI accepts them without a warning. |
| `engine/src/link.js`, `validate/links/` | Link capacity, queues and drops (roadmap step 3): a per-interface token-bucket shaper (`shape` and `shapeBack` link options in a spec), modeled on the Linux `tbf` qdisc. Frames that overflow the queue are dropped and counted. | `validate/links/run_kernel_links.py` compares frame counts per cable and queue drops against real Linux `tc qdisc … tbf` on veth links: 6 cases, all matching in `validate/links/results.md`. Runs in CI (sudo); `engine/test/link.test.js`. Not run locally: no root here. |
| `engine/src/dhcp.js`, `validate/dhcp/` | DHCP (roadmap step 4, part 1): a DHCP server on a node (`services.dhcp`) and a client action that gets an address for an interface marked `"dhcp"`. The address, server and lease are checked against Linux. | `validate/dhcp/run_kernel_dhcp.py` runs real `dnsmasq` as the server and `busybox udhcpc` as the client: 2 checks, the lease result and the frames on every cable, all matching in `validate/dhcp/results.md`. Runs in CI (sudo, installs `dnsmasq-base` and `busybox`); `engine/test/dhcp.test.js`. Not run locally: no root here. |
| `examples/` | Eight ready-to-run lab networks (spec, actions, README each) and `index.json`, for teachers. | `engine/test/examples.test.js` runs every lab through the CLI |
| `studio/` | Browser front end for the engine (plain HTML/JS, imports `engine/src`): map, frame-by-frame playback with reasons, device panels, storm badge, cable cut, and a console per device running the project's CLI (`cli/`) on the engine backend. Run it with `npm run studio` and open http://localhost:8640/studio/. It lists labs from `examples/index.json`. | `tests/studio/smoke.mjs` (Playwright, in CI) |
| `cli/` | Device CLI, Apache-2.0, no dependencies: user / privileged / config / interface / DHCP-pool modes, `?` help, Tab completion, abbreviations, `do`, `| json` / `| include` / `| exclude` on every show. Commands are JSON definition files (`cli/commands/`) that edit an OpenConfig-shaped model; the engine backend maps it to a spec node (addresses, static routes, switchport access/trunk, spanning tree, shutdown, shaping, DHCP relay, DNS, DHCP pools, TCP echo). `cli/bin/opr-cli.mjs` is the terminal program (interactive, `-c`, stdin, `--json`, `write`, `--render linux|frr|openwrt`). Linux, FRR and OpenWrt backends render only so far. Design: `docs/cli-design.md`; every command with examples and `| json` shapes: `docs/cli-reference.md`, generated by `node cli/tools/gen-reference.mjs` from the definitions and real sessions (`--check` tells if it is stale, CI runs it). | `cli/test/` (in CI): `show running-config` replayed on a blank device rebuilds the same spec node and cables for **every device of every spec** in `examples/` and `validate/`; every show answers `| json`; definition checks. Linux backend proof, `validate/cli/run_kernel_cli.py` (in CI, and `validate/docker/run.sh cli`): the three L3 validation networks and the two inter-VLAN networks are built in namespaces where every device is configured **only** by `opr-cli … --render linux --lab-parity`; **31/31 checks match the engine frame for frame, cable by cable, now including the router-on-a-stick and Layer 3 switch networks** (`validate/cli/results.md`). The rendered DNS names are served by validate/l3's stand-in, because the engine's DNS is a simplified protocol. Subinterface and SVI rendering is validated; switch STP rendering is unit-tested only so far. |
| `validate/docker/` | Mac recipe for the root checks: `run.sh` runs the kernel validators inside a privileged Linux container (`l2`, `l3`, `links`, `dhcp`, `storm`, `all`, `full`). Steps and troubleshooting in `docs/docker-validation.md`. | Runs the same checks as CI; CI (Ubuntu, sudo) is the merge reference. |

Published lab (private, owner shares it): https://claude.ai/artifact/HovFu2jwbZodRPv5bNzUH4. It's published from `web/index.html` with capabilities `db` (rules: `scores` read view/write owner; `scores/{self}` write interact) and `user` (scope profile). Pass that URL to republish.

## How to check everything

```bash
python3 tools/build_web.py --check
(cd poc/storm-math && python3 -m pytest -q)
python3 -m pytest -q tests
node tests/web/smoke.mjs
(cd engine && npm test)
sudo python3 validate/l3/run_kernel_l3.py
sudo python3 validate/l2/run_kernel_l2.py
sudo python3 validate/links/run_kernel_links.py
sudo python3 validate/dhcp/run_kernel_dhcp.py
```

The last four commands need root, iproute2 and `unshare`, and the DHCP check also needs `dnsmasq-base` and `busybox`. In a cloud session, install `iproute2` with apt first.

**On a Mac, do not run the last four commands with `sudo` on the host.** Use the privileged Linux container instead: `validate/docker/run.sh` runs the kernel checks (`l2`, `l3`, `links`, `dhcp`, `storm`, `all` or `full`). The steps and troubleshooting are in [docs/docker-validation.md](docker-validation.md). CI runs all of these on every push (`.github/workflows/ci.yml`) and is the reference result for merging.

## Decisions made

- **Language:** plain JavaScript for the engine, so it runs in the browser and Node with no build. Rust/WASM is deferred until speed matters.
- **Validation method:** every engine feature is checked against real Linux by building the same network from namespaces and comparing results **and per-cable frame counts**. Linux settings that change which frames appear are pinned to what the engine models: ICMP redirects off, ICMP rate limit off, rp_filter off, IPv6 off. Caches are flushed before each action. A feature isn't done until it matches.
- **Determinism:** the event queue breaks ties by sequence number; the same spec and actions always give the same frames.
- **Accuracy framing (lab):** the FAA hasn't published the flood's protocol. The lab is a teaching analogy (Layer 2 broadcast storm).

## Not modeled yet (engine)

RSTP, per-VLAN spanning tree, topology-change notices, MAC aging, dynamic routing (RIP, BGP, multi-area OSPF), IPv6, NAT, firewalls/ACLs, multi-vendor CLI. Link shaping covers only the token-bucket queue (no netem delay or loss).

## Roadmap (engine)

### Done

- **Spanning tree + VLANs in `engine/`: done** (PR #11). Real BPDUs, port roles and states checked against kernel bridges, VLAN trunks checked against VLAN-aware kernel bridges. Not yet: RSTP and per-VLAN spanning tree (see step 9).
- **Storm math inside the engine: done** (`engine/src/storm.js`: ρ, regime, growth rate, reach, from the live topology; matches `poc/storm-math` exactly; steady per-cable rates added in PR #19). Not yet: feeding the score into a detail-level scheduler.
- **Link capacity, queues, drops: done** (PR #13): token-bucket shaping per interface, checked against Linux `tbf`. `netem` (delay and loss) is not modeled; the cloud kernel lacks it.
- **DHCP: done** (PR #17): server and client checked against dnsmasq and udhcpc.
- **Spec format and CLI: done** (spec v1 in JSON, `openpacketrouter check|run|actions|schema`, `--trace`, `--text`). Still open: YAML input, and a version-2 spec when the new features need new fields.

### Next, in this order (approved 19 Nov 2026)

Each step counts as done only when it matches real Linux (or real FRRouting) frame for frame.

1. **TCP: done** (PR #30): handshake, data echo, close, SYN retransmission, RST, validated against Linux sockets (`validate/tcp/`). Not yet: data retransmission, windows, congestion control.
2. **DHCP relay: done:** a router relays DHCP for a subnet without a server, with server pools for relayed subnets (`services.dhcpRelay`, `services.dhcp.pools`). Modeled on and validated against dnsmasq relay mode (`validate/dhcp/`); Debian/Ubuntu busybox has no `dhcprelay`.
3. **Inter-VLAN routing: done** (PR #55): router-on-a-stick (802.1Q subinterfaces on one router port) and Layer 3 switch SVIs, validated against Linux 802.1Q subinterfaces and a vlan_filtering bridge with VLAN SVIs, 19/19 actions frame for frame (`validate/intervlan/`, in CI).
4. **MAC address aging: done** (PR #58): learned entries expire after a per-switch `agingTime` (default 300 s, like a Linux bridge's `ageing_time`). New actions `wait`, `macTable` and `keepCaches` let a lab watch entries expire. Validated against kernel bridges with two different aging times: pings (flooding vs unicast, frames per cable) and learned MAC tables, 6/6 steps matching (`validate/aging/`, in CI, `validate/docker/run.sh aging`). Lab: `examples/mac-aging`. CLI: `mac address-table aging-time SECONDS` (rendered for Linux as the bridge `ageing_time`). Not yet: the shortened aging after a topology change (step 5).
5. **Spanning-tree topology change notices:** TCN BPDUs, and switches flush (shorten aging on) their MAC tables after a topology change.
6. **RIPv2**, validated against FRRouting `ripd` in namespaces.
7. **OSPF: first part done** (PR #59): OSPFv2, single area, point-to-point and broadcast networks with DR/BDR election (`ospf` spec key, `engine/src/ospf.js`). Matches FRRouting `ospfd` in namespaces on neighbors, DR/BDR, routes, LSDB, hellos and packet types, through cable cuts and returns: 18/18 rows (`validate/ospf/`, in CI). Not yet: passive interfaces and timers (next PR), CLI `router ospf` commands and an example lab (after that); the validator specs are `.net` files until the CLI can round-trip them.
8. **Example lab networks** in `examples/` that run with the CLI: ten labs so far (loop with and without spanning tree, VLANs, DHCP, DHCP relay, shaped bottleneck, routed ping/traceroute/DNS, TCP, router on a stick, Layer 3 switch), each run by `engine/test/examples.test.js`; a lab is added as each feature above lands.
9. **Later:** RSTP / PVST+, EtherChannel/LACP, port security, DHCP snooping, storm control, LLDP, SPAN, NAT, ACLs, IPv6. Also kept from the earlier roadmap: mixed detail levels (swap one device between engine model and a real Linux namespace mid-traffic, the handoff experiment in `docs/vision.md`).

### Routing protocol decisions

- **IGRP: not planned.** It is obsolete and there is no real implementation to validate against.
- **EIGRP: low priority.** FRRouting's `eigrpd` support is partial, so frame-for-frame validation would be weak.

## Environment notes (cloud sessions)

- Root works; `unshare -n -m` gives an isolated network namespace. `ip netns` needs a private `/run` (`mount -t tmpfs none /run` inside the unshare).
- The cloud kernel has no IPv6 and no `netem`. `tbf`, `htb` and `pfifo` exist.
- Global Playwright is available in Node via `createRequire` (see `tests/web/smoke.mjs`). Chromium 153 locally; HTML-in-Canvas needs the `--enable-blink-features=CanvasDrawElement` flag there (Edge/Chrome 157+ have it by default).
- The session can push to `MrPerryAI/OpenPacketRouter` only (no new repos).
