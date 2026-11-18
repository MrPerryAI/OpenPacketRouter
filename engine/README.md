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
```

Exit codes: `0` ok, `1` invalid spec or actions (each problem is printed), `2` usage or file error. Only JSON is supported for now.

## Validated against real Linux

`validate/l3/run_kernel_l3.py` builds each spec out of Linux network namespaces. Every client, server and router is a real Linux network stack, every switch a kernel bridge. It runs the same actions and compares results **and the number of frames on every cable direction**. All 12 actions across three networks match exactly: [validate/l3/results.md](../validate/l3/results.md). The networks are a healthy routed FTI, a routing loop, and a missing return route.

The Linux settings that change which frames appear are pinned to what the engine models: ICMP redirects off, ICMP rate limiting off, and reverse-path filtering off. Caches are flushed before each action.

## Not modeled yet

TCP, DHCP, RSTP, topology-change notifications, per-VLAN spanning tree, dynamic routing (OSPF/BGP), link capacity and queues, IPv6, NAT, and firewalls.

## Tests

```bash
npm test                                  # 34 unit tests: engine, spec format, storm math, spanning tree, VLANs
```

## Storm math

`src/storm.js` answers "what would one broadcast do on this network?" from the live topology, without sending frames. It returns ρ (the spectral radius of the non-backtracking flood matrix), a regime (**tree**: broadcasts die out; **circulating**: frames loop without multiplying; **amplifying**: frames multiply, a storm), the growth rate and doubling time for amplifying networks, and the loop and reach edges. It respects link up/down, blocked switch ports, and per-link capacity. The model is the one in `poc/storm-math`; `tests/test_engine_storm.py` checks every scenario there for an exact match.

```bash
sudo python3 ../validate/l3/run_kernel_l3.py   # frame-for-frame against Linux (Linux host or CI)
```

On a Mac, never run the `sudo` line on the host. From the **repo root** run `validate/docker/run.sh l3` instead; it runs the same check in a privileged Linux container. The recipe is in [docs/docker-validation.md](../docs/docker-validation.md).

```bash
sudo python3 ../validate/l2/run_kernel_l2.py   # spanning tree roles + VLAN trunks vs Linux kernel bridges (on a Mac: validate/docker/run.sh l2)
```
