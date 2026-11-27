# OpenPacketRouter engine

A deterministic, packet-level network simulator in plain JavaScript (ES modules, no dependencies). It runs in the browser and in Node.

| Device | What it does |
|---|---|
| **Switch** | Learning bridge. It learns source MACs, forwards known unicast out one port, and floods broadcasts and unknown destinations. Ports can be marked `blocked`. Optional **spanning tree** (802.1D with real BPDUs: root bridge, root/designated/blocked ports, listening/learning/forwarding timers, max-age expiry) and **VLANs** (access and trunk ports, native VLAN, per-VLAN MAC tables; `vlans` in the spec). See `engine/src/stp.js`. |
| **Router** | IPv4 forwarding: longest-prefix match over connected and static routes, TTL decrement, ICMP time exceeded / net unreachable / host unreachable. |
| **Host / server** | Clients and servers: IPv4 interfaces, a default gateway, ARP, ICMP echo, and UDP services (a DNS-style name server built in; custom UDP handlers). |

Client actions: `ping`, `traceroute`, `dns`, `udpRequest`.

Every decision lands in `net.trace` with a plain-English reason, for example `route 172.16.20.0/24 via 10.255.3.2`, `flood: unknown destination`, `TTL ran out here`, or `no answer for 10.2.0.99 after 3 tries`.

```js
import {Network, ping, traceroute, dns} from "./src/index.js";
const net = Network.fromSpec(JSON.parse(fs.readFileSync("../validate/l3/fti-routed.json")));
ping(net, "ZFW-VOICE", "172.16.20.10");        // {ok: true, from: "172.16.20.10", rtt_ms: ...}
traceroute(net, "ZFW-VOICE", "172.16.20.10");  // hops: 10.1.0.1 → 10.255.1.1 → 10.255.2.2 → 10.255.3.2 → 172.16.20.10
dns(net, "ZME-VOICE", "10.0.0.53", "eld-radio.fti");
net.counters;                                  // frames sent per cable direction
```

## Spec files and the CLI

A network is a JSON spec file; the actions to run on it are a second JSON file. The format is documented in [docs/spec-format.md](../docs/spec-format.md). From `engine/`:

```bash
node bin/openpacketrouter.mjs check ../validate/l3/fti-routed.json            # validate a spec
node bin/openpacketrouter.mjs run   ../validate/l3/fti-routed.json            # runs its actions file
node bin/openpacketrouter.mjs run   spec.json actions.json --trace            # print every engine decision
node bin/openpacketrouter.mjs actions                                         # list action types
node bin/openpacketrouter.mjs schema                                          # JSON Schema of the spec format
node bin/openpacketrouter.mjs run   spec.json actions.json --text            # readable report instead of JSON
# Spec and actions files may also be YAML (.yaml/.yml): same schema as JSON, e.g. `run lab.yaml` picks up lab.actions.yaml.
# The reader is a small built-in subset (maps, lists, [..]/{..}, quoted strings, # comments); no anchors, tags or block scalars.
```

Exit codes: `0` ok, `1` invalid spec or actions (each problem is printed), `2` usage or file error. Only JSON is supported for now. The schema is in `spec.schema.json`, for editors and other tools.

## Validated against real Linux

`validate/l3/run_kernel_l3.py` builds each spec out of Linux network namespaces. Every client, server and router is a real Linux network stack, every switch a kernel bridge. It runs the same actions and compares results **and the number of frames on every cable direction**. All 12 actions across three networks match exactly: [validate/l3/results.md](../validate/l3/results.md). The networks are a healthy routed FTI, a routing loop, and a missing return route.

The Linux settings that change which frames appear are pinned to what the engine models: ICMP redirects off, ICMP rate limiting off, and reverse-path filtering off. Caches are flushed before each action.

## Not modeled yet

Per-VLAN spanning tree (one tree per VLAN), OSPFv3, and anything that needs a kernel feature the validators cannot pin to exact frames. Modeled and validated against real Linux: spanning tree and RSTP, VLANs, LACP, link capacity, queues, delay and loss, DHCP, TCP (including the receive window), NAT, ACLs, IPv6, RIP, OSPF (areas), LLDP, port security, storm control, SPAN, server services (HTTP, syslog, NTP) and VRRP. The status table in `docs/STATUS.md` is the source of truth.

## Tests

```bash
npm test                                  # 61 tests: engine, spec format, storm math, spanning tree, VLANs, link shaping, DHCP, TCP, CLI report, example labs
```

## TCP

A server with `services.tcp` (`{"7": "echo"}`) listens on a port; the `tcp` action opens a connection from a client, sends `size` bytes, reads them back and closes. The engine models the three-way handshake, data and ACKs, SYN retransmission (1 s, then doubling), RST for a closed port, and the FIN teardown, and matches real Linux sockets frame for frame: [validate/tcp/results.md](../validate/tcp/results.md). Not modeled: data retransmission, windows, congestion control, options.

## DHCP

A node with `services.dhcp` runs a DHCP server on its subnet: it hands out addresses from a range, with a lease time, and can name a router and DNS server. An interface marked `"dhcp"` has no address until a `dhcp` action runs a client on it. The engine picks the same address a real server gives and reports the server and lease. `validate/dhcp/` checks this against real `dnsmasq` and `udhcpc` (client): the lease result and the frames on every cable, in [validate/dhcp/results.md](../validate/dhcp/results.md). The spec keys are in [docs/spec-format.md](../docs/spec-format.md).

A router with `services.dhcpRelay` forwards a LAN's DHCP broadcasts to a server on another network (stamping its own address, `giaddr`, so the server can pick a pool), and the server's `services.dhcp.pools` give each relayed subnet its own range. The relay is modeled on and checked against dnsmasq's relay mode. Lab: [examples/dhcp-relay](../examples/dhcp-relay/).

## Link capacity and queues

A link option in a spec, `shape` or `shapeBack` on an interface's egress, puts a token-bucket shaper on that end, the way Linux's `tbf` qdisc does. Frames that wait too long for tokens queue up; a frame that would overflow the queue limit is dropped and counted. The engine follows the kernel's order (offer to the queue, then drain while tokens last) so the same burst gives the same drops. `validate/links/` checks the frame counts and drops against real `tc … tbf` on veth links: [validate/links/results.md](../validate/links/results.md). Delay and loss (netem) are not modeled.

## Storm math

`src/storm.js` answers "what would one broadcast do on this network?" from the live topology, without sending frames. It returns ρ (the spectral radius of the non-backtracking flood matrix), a regime (**tree**: broadcasts die out; **circulating**: frames loop without multiplying; **amplifying**: frames multiply, a storm), the growth rate and doubling time for amplifying networks, and the loop and reach edges. It respects link up/down, blocked switch ports, and per-link capacity. The model is the one in `poc/storm-math`; `tests/test_engine_storm.py` checks every scenario there for an exact match.

```bash
sudo python3 ../validate/l3/run_kernel_l3.py   # frame-for-frame against Linux (Linux host or CI)
```

On a Mac, never run the `sudo` line on the host. From the **repo root** run `validate/docker/run.sh l3` instead; it runs the same check in a privileged Linux container. The recipe is in [docs/docker-validation.md](../docs/docker-validation.md).

```bash
sudo python3 ../validate/l2/run_kernel_l2.py   # spanning tree roles + VLAN trunks vs Linux kernel bridges (on a Mac: validate/docker/run.sh l2)
```

## Examples

[examples/](../examples/) has ready-to-run lab networks (spec plus actions plus a README each) for teachers: a loop with and without spanning tree, VLANs, DHCP across a router, a shaped bottleneck, and routed ping/traceroute/DNS. `test/examples.test.js` runs each through the CLI.
