# OpenPacketRouter engine

A deterministic, packet-level network simulator in plain JavaScript (ES modules, no dependencies). It runs in the browser and in Node.

| Device | What it does |
|---|---|
| **Switch** | Learning bridge: learns source MACs (per VLAN, with ageing), forwards known unicast out one port, floods broadcasts and unknown destinations. Optional **802.1D spanning tree** (BPDUs, root election, root/designated/blocked ports, listening → learning → forwarding, topology-change notices, max-age expiry) and **802.1Q VLANs** (access ports, trunks with a native VLAN). |
| **Router** | IPv4 forwarding: longest-prefix match over connected and static routes, TTL decrement, ICMP time exceeded / net unreachable / host unreachable. VLAN subinterfaces (`eth0.10`) for router-on-a-stick. |
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

## Spanning tree and VLANs

```js
const net = Network.fromSpec(JSON.parse(fs.readFileSync("../validate/l2/stp-ring.json")));
net.runTo(12);                       // seconds since power-on: every switch starts STP at t = 0
net.stpReport();                     // root, root port, and each port's role and state, per switch
net.setLink("SW1:right", false);     // unplug a cable; both ends notice at once
net.diff(before, "bpdus");           // BPDUs per cable direction (net.counters holds everything else)
net.diff(before, "tagged");          // 802.1Q-tagged frames per "cable#vlan"
```

In a spec, a switch takes `"stp": true` or `{"priority", "hello", "forwardDelay", "maxAge"}` (802.1D defaults 32768, 2, 15, 20 s), and `"ports": {"f1": {"vlan": 10}, "up": {"trunk": [10, 20], "native": 1, "cost": 19, "priority": 128}}`. Ports are numbered in the order they are cabled. Default path cost is 19 (100 Mb/s in the 802.1D-1998 table).

The model is the Linux kernel bridge: classic 802.1D (not RSTP), one spanning tree for all VLANs (Cisco's PVST+ runs one per VLAN), only the root originates hellos, at most one BPDU per port per second, MAC ageing drops to 2 × forward delay during a topology change, and BPDUs travel untagged. A switch without STP floods BPDUs like any other multicast, so STP switches on either side still see each other.

## Validated against real Linux

`validate/l3/run_kernel_l3.py` builds each spec out of Linux network namespaces. Every client, server and router is a real Linux network stack, every switch a kernel bridge. It runs the same actions and compares results **and the number of frames on every cable direction**. All 12 actions across three networks match exactly: [validate/l3/results.md](../validate/l3/results.md). The networks are a healthy routed FTI, a routing loop, and a missing return route.

The Linux settings that change which frames appear are pinned to what the engine models: ICMP redirects off, ICMP rate limiting off, and reverse-path filtering off. Caches are flushed before each action.

`validate/l2/run_kernel_l2.py` does the same for spanning tree and VLANs, against kernel bridges running the kernel's own STP (`stp_state 1`) and VLAN-aware bridges (`vlan_filtering 1`): port states and roles, BPDU contents and which cables carry them, and data frames (and their VLAN tags) cable by cable, at the same moments during convergence and after cables are cut: [validate/l2/results.md](../validate/l2/results.md).

## Not modeled yet

RSTP/MSTP and per-VLAN spanning tree, TCP, DHCP, dynamic routing (OSPF/BGP), link capacity and queues, IPv6, NAT, and firewalls.

## Tests

```bash
npm test                                  # unit tests
```

```bash
sudo python3 ../validate/l3/run_kernel_l3.py   # frame-for-frame against Linux
sudo python3 ../validate/l2/run_kernel_l2.py   # spanning tree and VLANs against Linux bridges
```
