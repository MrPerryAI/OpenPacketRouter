# Project status and hand-off

*Last updated 19 Nov 2026. Read this first in a new session. CLAUDE.md has the rules; this file has the state.*

## Direction

**Focus: the engine (`engine/`).** The goal is an open, production-close, multi-vendor network simulator for teaching. Its core idea is mixed detail levels: cheap models for the background, with real software (Linux, FRRouting, vendor images) swapped in where a student is looking. See `docs/vision.md`.

**The classroom lab is frozen.** `web/` (El Dorado Storm Lab) and `labs/packet-tracer/` are finished and in use. Fix bugs only if asked; don't add features. The lab will later be rebuilt on top of the engine.

## v1.0 definition of done

v1.0 is a free, CLI-first teaching simulator. An item is ticked only when its pull request is merged with every CI check green and, for features, a validator that matches real Linux or FRRouting frame for frame. Owner of each item in brackets; the lead keeps this list current.

**A. Close open work**
- [x] OSPF CLI commands, `show ip ospf`, FRR rendering, with ospfd configured only from the CLI in CI (PR #68) [docs]
- [x] NAT: translation table compared against conntrack (PR #83) [dhcp-tcp]
- [x] Topology change validator flake fixed (PR #86) [stp-vlan]
- [x] LLDP: exact LLDPDU counts per cable (PR #87) [checker]

**B. Routing**
- [x] OSPF multi-area (ABR, summary LSAs) vs ospfd [checker] (PR #90)
- [ ] OSPF redistribution (ASBR, external LSAs) vs ospfd [checker]
- [ ] BGP basics (eBGP, iBGP, prefixes, basic path selection) vs bgpd [checker]
- [ ] VRRP first-hop redundancy vs keepalived, CLI in our own words [first free agent]

**C. Switching**
- [x] Port security, or recorded here as not validatable [stp-vlan]
- [x] Storm control, or recorded here as not validatable [stp-vlan]
- [x] DHCP snooping, or recorded here as not validatable [stp-vlan]
- [x] RSTP, CI-only check with mstpd in the runner's initial namespace [stp-vlan]

**D. Mirroring and IPv6**
- [x] SPAN port mirroring vs tc mirred [dhcp-tcp] (PR #144: frame counts and the ordered frames each monitor port sends)
- [x] IPv6: addresses, NDP, ICMPv6, static routes vs Linux [dhcp-tcp] (PR #155). Modelled = global addresses, NS/NA, echo, static routes. Not modelled yet = link-local addresses as routing targets (they are used only as solicitation sources), NUD re-probing of used neighbors (the validator pins Linux's delay_first_probe_time high), DAD, MLD, RS/RA/SLAAC (the validator pins Linux with nodad and drops MLD/RS/DAD chatter on output, so those are simply absent from the comparison).
- [x] RIPng vs FRRouting ripngd [dhcp-tcp] (tables and packets on every cable; link-local next hops). Not modelled: next-hop entries naming another router, route maps, redistribution. OSPFv3 is still open.

**E. Transport and links**
- [ ] TCP data retransmission and window behaviour vs Linux (segments and retransmission timer done, PR #133; receive window not yet) [ui]
- [x] Link delay and loss vs netem [links]: delay and deterministic loss (Gilbert-Elliott with every probability 0% or 100%) match `tc netem` frame for frame (`validate/netem/`). Random loss (probabilities between 0 and 100%) is not validatable frame for frame, so the engine rejects it.
- [x] Server services (HTTP GET, NTP, syslog) vs real Linux tools [dhcp-tcp]: HTTP GET and syslog done (HTTP/1.0 server vs a Python socket server and client, in validate/tcp; segments per direction, like tcp-loss); syslog: UDP 514 receiver vs util-linux `logger`, validate/services; NTP: UDP 123 server (stratum, 48-byte packets) vs `ntpdate -q` (real client) against a minimal Python responder (validate/services); compared: reply stratum, the request the server saw (version, mode, length) and frames per cable direction; NTP timestamps are wall-clock vs simulated time, so they are not compared

**F. CLI**
- [x] Every spec key has a configure command and a show with `| json` [stp-vlan]: the last gaps were closed here (cable `delay N`, `loss pattern`, a Layer 3 switch's default route as `ip route 0.0.0.0/0`, and `network interface` under `router ospf` replaying in order); `cli/test/allkeys.test.js` fails when a node key of the spec format has no command in `cli/test/fixtures/all-keys.json`; lab `examples/link-loss`.
- [x] YAML spec input (PR #93; Studio opens and saves YAML, PR #121) [docs]
- [ ] FRR backend proof: rendered frr.conf in real FRR gives the engine's tables (OSPF PR #68 and RIP PR #134 done; static routes and new protocols as they land) [docs]
- [x] OpenWrt backend proof: OpenWrt rootfs container in CI applies the rendered UCI [docs] (`validate/openwrt/`, PR #156). Covers addresses, static and default routes; `uci` accepts and stores them. netifd is not booted; VLAN/firewall rendering not yet proven.
- [x] A student guide for every example lab (PR #101; a test makes every new lab ship one) [docs]

**G. Studio**
- [ ] Browser topology editor (PR #89) and visual features: save/export JSON and YAML (#105, #121), protocol panels (#98), console tabs (#125), playback filters (#131), keyboard and phone layout (#139) done [ui]

**H. Release prep**
- [ ] README quick start (done), CHANGELOG (`CHANGELOG.md`, kept current) and v1.0 release notes (`docs/release-notes-v1.0.md`, draft) (no tag, npm publish or GitHub release: the owner decides) [lead]

**Later, not in v1.0:** the research ideas in `docs/vision.md` (mixed detail levels, device handoff, git-style state, quirk layers), vendor images, wireless.

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
| `engine/src/lacp.js`, `Switch.addChannel` in `engine/src/network.js`, `validate/lacp/` | Link aggregation (LACP, 802.3ad): port-channels on switches, state machines modeled on the kernel bonding driver, layer2 transmit hash, failover on cable loss; checked against kernel bonds (roadmap step 10). | `python3 validate/lacp/run_kernel_lacp.py` in the validation container |
| `engine/src/link.js`, `validate/links/` | Link capacity, queues and drops (roadmap step 3): a per-interface token-bucket shaper (`shape` and `shapeBack` link options in a spec), modeled on the Linux `tbf` qdisc. Frames that overflow the queue are dropped and counted. | `validate/links/run_kernel_links.py` compares frame counts per cable and queue drops against real Linux `tc qdisc … tbf` on veth links: cases for UDP bursts, ARP, and spanning-tree BPDUs (52 bytes at the qdisc: queue 52 passes them, queue 51 drops them), see `validate/links/results.md`. `frameBytes` sizes every frame kind the engine sends (BPDU, LACPDU, LLDP, IPv6 too), so a shaped cable no longer crashes on non-IP frames; LLDP, LACPDU and IPv6 sizes are from the wire formats and are only unit-tested. Runs in CI (sudo); `engine/test/link.test.js`. Not run locally: no root here. |
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

RSTP, per-VLAN spanning tree, BGP, multi-area OSPF, IPv6, stateful firewalls (NAT is supported: see step 11), multi-vendor CLI. Link shaping covers only the token-bucket queue (no netem delay or loss).

## Roadmap (engine)

### Done

- **Spanning tree + VLANs in `engine/`: done** (PR #11). Real BPDUs, port roles and states checked against kernel bridges, VLAN trunks checked against VLAN-aware kernel bridges. Not yet: per-VLAN spanning tree; RSTP followed (see step 9).
- **Storm math inside the engine: done** (`engine/src/storm.js`: ρ, regime, growth rate, reach, from the live topology; matches `poc/storm-math` exactly; steady per-cable rates added in PR #19). Not yet: feeding the score into a detail-level scheduler.
- **Link capacity, queues, drops: done** (PR #13): token-bucket shaping per interface, checked against Linux `tbf`. `netem` (delay and loss) is not modeled; the cloud kernel lacks it.
- **DHCP: done** (PR #17): server and client checked against dnsmasq and udhcpc.
- **Spec format and CLI: done** (spec v1 in JSON, `openpacketrouter check|run|actions|schema`, `--trace`, `--text`). Still open: YAML input, and a version-2 spec when the new features need new fields.

### Next, in this order (approved 19 Nov 2026)

Each step counts as done only when it matches real Linux (or real FRRouting) frame for frame.

1. **TCP: done** (PR #30): handshake, data echo, close, SYN retransmission, RST, validated against Linux sockets (`validate/tcp/`). Data segmentation (MSS 1448) and retransmission on a 200 ms timer that doubles: done (PR #133, `validate/tcp/tcp-loss`: a dropped segment, the 200 ms retransmission, TCP_INFO unacked and retransmit counts). Not yet: receive windows, congestion control.
2. **DHCP relay: done:** a router relays DHCP for a subnet without a server, with server pools for relayed subnets (`services.dhcpRelay`, `services.dhcp.pools`). Modeled on and validated against dnsmasq relay mode (`validate/dhcp/`); Debian/Ubuntu busybox has no `dhcprelay`.
3. **Inter-VLAN routing: done** (PR #55): router-on-a-stick (802.1Q subinterfaces on one router port) and Layer 3 switch SVIs, validated against Linux 802.1Q subinterfaces and a vlan_filtering bridge with VLAN SVIs, 19/19 actions frame for frame (`validate/intervlan/`, in CI).
4. **MAC address aging: done** (PR #58): learned entries expire after a per-switch `agingTime` (default 300 s, like a Linux bridge's `ageing_time`). New actions `wait`, `macTable` and `keepCaches` let a lab watch entries expire. Validated against kernel bridges with two different aging times: pings (flooding vs unicast, frames per cable) and learned MAC tables, 6/6 steps matching (`validate/aging/`, in CI, `validate/docker/run.sh aging`). Lab: `examples/mac-aging`. CLI: `mac address-table aging-time SECONDS` (rendered for Linux as the bridge `ageing_time`). Not yet: the shortened aging after a topology change (step 5).
5. **Spanning-tree topology change notices: done** (PR #69): a switch that sees a port change sends TCN BPDUs toward the root; the root sets the topology-change flag in its BPDUs, and while it is set every switch ages its MAC table with the forward delay instead of its aging time. MAC aging now follows the kernel bridge garbage collector. Validated against kernel bridges (`stp_state 1`) on a four-switch ring through cable cuts and restores: topology-change flags and aging in force, BPDU kinds (config, TC, TCA, TCN) on every cable direction, ping frames per cable and MAC tables, 21/21 steps (`validate/tcn/`, in CI). Lab: `examples/stp-topology-change`.
6. **RIPv2: done** (PR #70): RIP version 2 on routers (`rip` spec key, `engine/src/rip.js`): networks, passive interfaces, split horizon (simple, poisoned or off), triggered updates, timers. Matches FRRouting `ripd` in namespaces on route tables, the last update on every cable, newly poisoned routes and requests, through cable cuts, timeouts, garbage collection and restores: 17/17 rows (`validate/rip/`, in CI). CLI: `router rip` commands. Labs: `examples/rip-chain` and `examples/count-to-infinity` (a teaching scenario with triggered updates off; engine only).
7. **OSPF: done** (PRs #59, #71, #68): OSPFv2, single area, point-to-point and broadcast networks with DR/BDR election, passive interfaces, multi-hop flooding and ospfd-style LSA origination (`ospf` spec key, `engine/src/ospf.js`). Matches FRRouting `ospfd` in namespaces on neighbors, DR/BDR, routes, LSDB, hellos and packet types, through cable cuts and returns, including a mixed p2p/LAN network (`validate/ospf/`, in CI). On a switched LAN, LS Requests are compared per switch rather than per cable, because ospfd's choice of which neighbor to ask depends on packet timing (documented in `validate/ospf/README.md`). Known: a rare (about 1 in 27 runs) extra ack on a p2p cable in `ospf-p2p`. CLI: `router ospf` commands and `show ip ospf` (PR #68); in CI the same comparison runs again with ospfd configured only from the CLI's FRR rendering. Not yet: an example lab and multi-area (in review, PR #90).
8. **Example lab networks** in `examples/` that run with the CLI: fifteen labs so far (loop with and without spanning tree, VLANs, DHCP, DHCP relay, shaped bottleneck, routed ping/traceroute/DNS, TCP, router on a stick, Layer 3 switch, MAC aging, topology change, RIP chain, count to infinity, access lists), each run by `engine/test/examples.test.js`; a lab is added as each feature above lands.
9. **Later:** RSTP / PVST+, DHCP snooping, storm control, SPAN, IPv6. (NAT and LLDP are done: steps 11 and 12.)
   - **IPv4 access lists: done** (PR #74): named lists of permit/deny rules (ip/icmp/tcp/udp, prefixes, ports, ICMP type, `established`) bound in/out per router interface, rejecting with ICMP administratively prohibited; a TCP connect fails at once on that ICMP error, like Linux. Validated against Linux nftables (prerouting/forward chains): 12/12 actions match on results and frames per cable direction (`validate/acl/`, in CI). CLI: `ip access-list`, `ip access-group`, `show access-lists`. Lab: `examples/acl-lab`. The CLI's nftables rendering is string-tested only. Also kept from the earlier roadmap: mixed detail levels (swap one device between engine model and a real Linux namespace mid-traffic, the handoff experiment in `docs/vision.md`).
   - **RSTP: engine done, validated in CI only:** rapid spanning tree (802.1w) on switches (`stp.mode: "rstp"`, `engine/src/rstp.js`): proposal/agreement handshake, root/designated/alternate/backup roles, edge ports (admin `portfast` and automatic after 3 s without BPDUs), fast failover, topology-change flags with MAC flushing, and fallback to classic BPDUs next to a classic STP bridge. The code follows the state machines of `mstpd`, the userspace daemon the Linux bridge hands RSTP to (`stp_state 2`); that only works in the initial network namespace, so `validate/rstp/` runs mstpd bridges on the GitHub runner host (workflow `.github/workflows/rstp.yml`, mstpd built from source; not runnable in the Docker container or on a Mac). It compares each bridge's root, root port, cost, and every port's role, state and edge flag, and the kinds of BPDU (flags byte) per cable direction in quiet windows, through a cable cut and its return: 8/8 steps match. Start-up and reconvergence transients are not compared (mstpd's BPDU timing follows its own one-second ticks). Not yet: MSTP/PVST, per-port BPDU guard/root guard, data-plane traffic checks (MAC flush on a topology change is engine-tested only). CLI: `spanning-tree mode rstp`, `spanning-tree portfast`. Lab: `examples/rstp-fast-failover`.
10. **LACP link aggregation: done** (`engine/src/lacp.js`, `validate/lacp/`): parallel cables between switches bundle into a port-channel (`channels` spec key; CLI `channel-group N mode active`, `lacp rate fast`, `show etherchannel summary`). The LACP state machines follow the Linux bonding driver (mode 802.3ad); validated against kernel bonds on every member's carrier and LACP state bytes through a handshake, a cut cable and its return, which LACPDU kinds each cable carries, and the data frames per cable (transmit hash `layer2`, with the engine's MAC addresses on the kernel interfaces). LACPDU timing is only compared as windows (the kernel's 100 ms timer drifts under load). Not yet: passive mode, `min-links`, other hash policies, spanning tree over a channel.
11. **NAT on routers: done** (PR #79): source NAT overload (PAT), static 1:1 NAT and port forwarding, with CLI `ip nat` commands. Validated against Linux nftables (masquerade, snat, dnat) in namespaces: pings, TCP, UDP, DNS and traceroute through the NAT, frame for frame on every cable direction, 12/12 rows (`validate/nat/`, in CI, `validate/docker/run.sh nat`). Lab: `examples/nat-lab`.
12. **LLDP: engine done** (PR #82): LLDP on routers, hosts and servers (`lldp` spec key, `engine/src/lldp.js`); switches drop LLDP unless `forwardLldp` is set (bridge `group_fwd_mask`). Validated against lldpd in namespaces: neighbor tables, LLDPDU contents per cable direction and exact LLDPDU counts per cable (PR #87; the engine's start-up LLDPDU is left out of the first window, because lldpd sends its own before capture starts), through cable cuts, TTL expiry and restores, 7/7 snapshots (`validate/lldp/`, in CI). Not yet: CLI commands (`lldp run`, `show lldp neighbors`) and an example lab.
13. **Port security: done** (PR #128): `portSecurity: {port: {max, violation}}` on a switch (CLI `switchport port-security maximum N`, `violation protect|restrict|shutdown`, `show port-security`). The first N source MACs on a port are secured for good; others are dropped before learning and counted. Validated against Linux nftables (bridge-family prerouting with a dynamic set of `size N`; Linux bridges have no per-port MAC limit of their own): `validate/portsec/`. `shutdown` (err-disable) has no netfilter equivalent and is covered by engine tests only. Example lab `examples/port-security`.
14. **Storm control (broadcast): done** (PR #141): `stormControl: {port: {broadcast: {rate, burst}}}` on a switch (CLI `storm-control broadcast rate RATE burst BYTES`, `show storm-control`): a token-bucket policer on the port's ingress that drops broadcast frames over the rate, before the switch sees them. Validated against Linux `tc ... flower dst_mac ff:ff:ff:ff:ff:ff action police` on bridge ports (`validate/storm-control/`: frames per cable and policer drops). Multicast limits are not modeled (no engine host originates multicast to compare). Hosts can now send to the limited broadcast address 255.255.255.255. Example lab `examples/storm-control`.
15. **DHCP snooping (server-message filtering): done** (`stp-vlan-snoop`): `dhcpSnooping: {trusted: [ports]}` on a switch (CLI `ip dhcp snooping`, `ip dhcp snooping trust`, `show ip dhcp snooping`): a DHCP server message (UDP 67 to 68) on any untrusted port is dropped and counted, so rogue servers are ignored. Validated against nftables bridge rules (`udp sport 67 udp dport 68 drop`) with dnsmasq servers (one rogue) and udhcpc clients: client results, frames per cable and per-port drop counts (`validate/dhcp-snooping/`, in CI). **Not validatable, so not built:** the binding table, dynamic ARP inspection and IP source guard (Linux has no equivalent). Example lab `examples/dhcp-snooping`.

### Routing protocol decisions

- **IGRP: not planned.** It is obsolete and there is no real implementation to validate against.
- **EIGRP: low priority.** FRRouting's `eigrpd` support is partial, so frame-for-frame validation would be weak.

## Environment notes (cloud sessions)

- Root works; `unshare -n -m` gives an isolated network namespace. `ip netns` needs a private `/run` (`mount -t tmpfs none /run` inside the unshare).
- The cloud kernel has no IPv6 and no `netem`. `tbf`, `htb` and `pfifo` exist.
- Global Playwright is available in Node via `createRequire` (see `tests/web/smoke.mjs`). Chromium 153 locally; HTML-in-Canvas needs the `--enable-blink-features=CanvasDrawElement` flag there (Edge/Chrome 157+ have it by default).
- The session can push to `MrPerryAI/OpenPacketRouter` only (no new repos).
