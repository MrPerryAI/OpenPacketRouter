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

## Validated against real Linux

`validate/l3/run_kernel_l3.py` builds each spec out of Linux network namespaces. Every client, server and router is a real Linux network stack, every switch a kernel bridge. It runs the same actions and compares results **and the number of frames on every cable direction**. All 12 actions across three networks match exactly: [validate/l3/results.md](../validate/l3/results.md). The networks are a healthy routed FTI, a routing loop, and a missing return route.

The Linux settings that change which frames appear are pinned to what the engine models: ICMP redirects off, ICMP rate limiting off, and reverse-path filtering off. Caches are flushed before each action.

## Not modeled yet

TCP, DHCP, RSTP, topology-change notifications, per-VLAN spanning tree, dynamic routing (OSPF/BGP), link capacity and queues, IPv6, NAT, and firewalls.

## Tests

```bash
npm test                                  # unit tests
```

```bash
sudo python3 ../validate/l3/run_kernel_l3.py   # frame-for-frame against Linux
```

```bash
sudo python3 ../validate/l2/run_kernel_l2.py   # spanning tree roles + VLAN trunks vs Linux kernel bridges
```
