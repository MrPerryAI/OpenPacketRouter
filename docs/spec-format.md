# Network spec format, version 1

A network is one JSON file; what to do on it is a second JSON file (actions). The engine, the CLI and
the Linux validators (`validate/*/run_kernel_*.py`) all read the same two files, so a spec that passes
the validator is the same network the engine simulates.

The reference implementation is `engine/src/spec.js` (`validateSpec`, `validateActions`, `runActions`).
A JSON Schema of the structure is in `engine/spec.schema.json` (`openpacketrouter schema` prints it) for editors
and other tools; `openpacketrouter check` also checks meaning (gateways on a subnet, cabled interfaces exist).

## Running it

```bash
node engine/bin/openpacketrouter.mjs check validate/l3/fti-routed.json            # validate only
node engine/bin/openpacketrouter.mjs run   validate/l3/fti-routed.json            # uses fti-routed.actions.json
node engine/bin/openpacketrouter.mjs run   spec.json actions.json --trace         # add every engine decision
node engine/bin/openpacketrouter.mjs run   spec.json actions.json --text          # readable report instead of JSON
node engine/bin/openpacketrouter.mjs actions                                      # list action types
node engine/bin/openpacketrouter.mjs run   examples/vlans/spec.json examples/vlans/actions.json --text   # ready-made labs: see examples/
```

(`npm link` in `engine/` installs it as `openpacketrouter`.) Exit codes: `0` ok, `1` the spec or actions
are invalid (every problem is printed to stderr as `error: spec $.path: message`), `2` usage or file error.

## Spec

```json
{
  "version": 1,
  "name": "Two LANs",
  "about": "Free text.",
  "nodes": [
    {"name": "R1", "kind": "router", "ifaces": {"a": "10.0.0.1/24", "b": "10.1.0.1/24"}},
    {"name": "SW1", "kind": "switch"},
    {"name": "PC1", "kind": "host", "ifaces": {"eth0": "10.0.0.10/24"}, "gw": "10.0.0.1"},
    {"name": "DNS", "kind": "server", "ifaces": {"eth0": "10.1.0.53/24"}, "gw": "10.1.0.1",
     "services": {"dns": {"pc1.lan": "10.0.0.10"}}}
  ],
  "links": [["R1:a", "SW1:p1", 1], ["PC1:eth0", "SW1:p2"], ["R1:b", "DNS:eth0", 2]]
}
```

| Key | Meaning |
|---|---|
| `version` | Format version. Optional; missing means `1`. Any other number is rejected. |
| `name`, `about` | Free text. `name` is echoed in CLI results. |
| `nodes[]` | Devices. `name` is unique and has no `:`. `kind` is `switch`, `router`, `host` or `server`. |
| `ifaces` | Routers/hosts/servers: interface name → `"a.b.c.d/len"`, or `"dhcp"` for an interface that gets its address from a DHCP server. Switch ports are created by `links`. A name like `eth0.10` is an 802.1Q **subinterface** of `eth0` in VLAN 10 (router on a stick): it shares `eth0`'s MAC and cable and sends and receives frames tagged 10; untagged frames stay with `eth0`. Cable the parent (`R:eth0`), never the subinterface; `eth0` needs no address of its own. **Layer 3 switch:** on a VLAN-aware switch, `ifaces` holds SVIs named `vlanN` (`{"vlan10": "10.0.10.1/24"}`): the switch routes between its VLANs, like Linux vlan devices on a `vlan_filtering` bridge. A switch with SVIs may also have `gw` and `routes`, and can be the `src` of an action. |
| `gw` | Default gateway. Must be on one of the node's subnets. |
| `routes` | Static routes: `[["10.2.0.0/24", "10.0.0.2"], …]`. The next hop must be on one of the node's subnets. |
| `services.dns` | A DNS server on UDP 53: name → IPv4 address. |
| `services.dhcp` | A DHCP server on the node's subnet: `{"range": ["first", "last"], "lease": 3600, "router": "ip", "dns": "ip"}`. `lease` is seconds (default 3600); `router` and `dns` are optional. The first address of the range must be on one of the node's subnets. |
| `services.dhcp.pools` | Extra pools for relayed subnets: `[{"range": ["first", "last"], "mask": "255.255.255.0", "router": "ip"}]`. The server picks the pool that contains the relay's address. |
| `services.dhcpRelay` | A router that relays DHCP broadcasts on some interfaces to a server elsewhere: `{"server": "10.0.0.1", "clients": ["lan"]}`. `clients` lists the router's own interfaces to listen on. |
| `services.tcp` | A TCP server: `{"7": "echo"}` listens on port 7 and echoes what it receives. |
| `forwardLldp` | Switches: `true` lets LLDP frames (01:80:c2:00:00:0e) through, like a Linux bridge with `group_fwd_mask 0x4000`; default `false` (link-local, never forwarded). |
| `lldp` | (routers, hosts, servers) LLDP: `{"txInterval": 30, "holdMultiplier": 4}` (both optional, TTL is their product; `"description"` sets the System Description). Sends to 01:80:c2:00:00:0e on every cabled interface (first frame 1 s after carrier, then every txInterval) with chassis ID (MAC of the first interface), port ID (the interface MAC), port description, system name, system description and capabilities; keeps a neighbor table (`lldpNeighbors` action) with TTL expiry. Engine: `engine/src/lldp.js`, validated against `lldpd` in `validate/lldp/`. |
| `agingTime` | Switches: seconds a learned MAC address stays in the MAC table without being heard from (above 0; default 300, like a Linux bridge's `ageing_time`). |
| `ifaces6`, `routes6`, `gw6` | (routers, hosts, servers) IPv6: `ifaces6` maps interface name → `"2001:db8::1/64"` (one per interface; the name may also appear in `ifaces`), `routes6` is `[["prefix/len", "next hop"]]`, `gw6` the default gateway. Use global addresses for next hops: link-local addresses are not modelled. Addresses are ready at once (no duplicate address detection). `ping` accepts an IPv6 `dst`; errors are named `no route`, `address unreachable`, `time exceeded`. Neighbor discovery: a solicitation to the solicited-node group, up to 3 tries a second apart, a unicast advertisement back, and the target learns the asker from the solicitation. Matches Linux: [validate/ipv6/results.md](../validate/ipv6/results.md). |
| `rip` | (routers) RIPv2: `{"networks": ["10.0.0.0/8" or interface names], "passive": [ifaces], "splitHorizon": "poisoned" (or "simple", "off"), "timers": {"update": 30, "timeout": 180, "garbage": 120, "holdoff": 3}, "triggered": true}`. Only `networks` is required. `triggered: false` is a teaching knob (not in FRR). Actions `ripTable` (one router's table) and `ripRoute` (one network on every router). Matches FRRouting ripd: [validate/rip/results.md](../validate/rip/results.md). |
| `acl` | (routers) IPv4 access lists: `{"lists": {"NAME": [rule, …]}, "bind": {"eth0": {"in": "NAME", "out": "NAME"}}}`. A rule is `{"action": "permit"/"deny", "proto": "ip"/"icmp"/"tcp"/"udp", "src"/"dst": "any"/address/prefix, "sport"/"dport": 80 or "8000-9100", "icmpType": 8, "established": true}`. First match wins, no match = deny; a denied packet is dropped and the sender gets ICMP administratively prohibited. `in` acts before routing (netfilter prerouting), `out` on forwarded packets only. Multicast and broadcast are never filtered. Checked against nftables: engine/src/acl.js, validate/acl/. |
| `blocked` | Switches: ports that drop everything. A manual override; spanning tree (`stp`) blocks ports by itself. |
| `channels` | Switches: port-channels (link aggregation with LACP, 802.3ad): `{"Po1": {"ports": ["p3", "p4"], "rate": "slow"}}`. The listed ports must be cabled and are bundled into one logical port named `Po1`, which `vlans` can configure and the MAC table shows. `rate` is how often this switch asks its peer to send LACPDUs: `slow` (30 s, default) or `fast` (1 s). Frames leave over one member chosen by the Linux `layer2` hash. Not combined with `stp`. |
| `stp` | Switches: turns on spanning tree. Optional fields: `priority` (default 32768), `mac`, `hello` (2 s), `maxAge` (20 s), `forwardDelay` (15 s), `cost` (`{"p1": n}`), `portPriority` (`{"p1": n}`). Timers are in seconds, the 802.1D defaults in brackets. Topology changes are automatic: TCN BPDUs go up to the root, the root sets a flag in its BPDUs for `forwardDelay + maxAge` seconds, and while a switch has the flag its MAC entries expire after `forwardDelay` instead of `agingTime`. |
| `vlans` | Switches: makes the switch VLAN-aware. Per port: `{"access": 10}` or `{"trunk": [10, 20], "native": 1}`. Ports not listed are access VLAN 1. |
| `vlanNames` | Switches: labels for VLANs, `{"10": "sales", "20": "lab"}` (VLAN number 1-4094 → name). Labels only: they show in `show vlan` and the CLI `vlan N` / `name` commands and change no forwarding. |
| `links[]` | Cables: `["node:iface", "node:iface", delayMs?, {shape?, shapeBack?}?]`. Delay defaults to 1 ms. Each end may be cabled once. `shape` limits the egress of the first end and `shapeBack` the second: `{"rate": "1mbit", "burst": 3000, "limit": 4000}` (bytes for burst and queue). Modeled on the Linux `tbf` qdisc: rate is the link's capacity, burst is how much may leave back to back, limit is the queue; frames that overflow it are dropped. |
| `ospf` | (routers) OSPFv2, single area 0: `{"routerId": "1.1.1.1", "networks": ["10.0.0.0/8" or interface names], "passive": [ifaces], "interfaces": {"eth0": {"type": "point-to-point", "priority": 1, "cost": 10, "hello": 10, "dead": 40, "retransmit": 5}}}`. Only `networks` is required; the router ID defaults to the highest interface address and `dead` to four times `hello`. Interfaces are broadcast networks unless `type` says `point-to-point`. Neighbor states, DR/BDR election, router and network LSAs and SPF routes match FRRouting ospfd: [validate/ospf/results.md](../validate/ospf/results.md). Not modeled: other areas, external routes, authentication, ECMP forwarding. |

Unknown keys are **warnings**, not errors, so a spec written for a newer feature still loads (the key is
ignored). Features that add keys register them with `registerNodeKeys(kind, keys)` in `spec.js`, which
silences the warning.

`check` also warns about interface and port names that read as an `ip link` keyword, such as `a` (address),
`m` (mtu) or `up`. The Linux validators build interfaces with `ip link`, so those names can't be built there.
Use names like `eth0` for hosts and routers, and `p1` for switch ports.

## Actions

A JSON array. Each action starts from a cold network (ARP caches and switch MAC tables flushed), so its
frame counts don't depend on the order of actions — the same rule the Linux validators use.

| `do` | Required | Optional |
|---|---|---|
| `ping` | `src`, `dst` | `ttl` (64), `timeout` s (2) |
| `traceroute` | `src`, `dst` | `maxHops` (8) |
| `dns` | `src`, `server`, `name` | |
| `tcp` | `src`, `dst`, `port` | `size` (bytes to send and get echoed; none by default), `timeout` s. Opens a connection, sends the data, closes. The result is `ok` or `error` (`refused`, `timeout`) plus the `wire` list of segments the client sent and received. |
| `udp` | `src`, `dst`, `port` | |
| `udpBurst` | `src`, `dst`, `port`, `count`, `size` | sends `count` UDP datagrams of `size` bytes back to back, to load a shaped link |
| `wait` | `seconds` | Pauses simulated time, so MAC entries age. Actions flush caches first unless `"keepCaches": true`; put it on the actions around a `wait`. |
| `macTable` | `switch` | The switch's MAC table now: `{vlan, mac, port, age}` per entry. |
| `dhcp` | `src` | `iface` (default: the first interface marked `"dhcp"`), `tries` (3), `interval` (1 s). Runs a DHCP client; the result is the address, server and lease. |

Every action also takes `settle` (seconds to let frames in flight land after the answer, default 1; 0 for `wait` and `macTable`) and `keepCaches` (true: do not flush ARP caches and MAC tables before this action).
Features add action types with `registerAction(name, {required, run})`.

## Result (`openpacketrouter.result/1`)

```json
{"format": "openpacketrouter.result/1", "spec": "Two LANs", "specVersion": 1,
 "actions": [{"action": {...}, "result": {"ok": true, "from": "10.1.0.53", "rtt_ms": 8},
              "frames": {"PC1:eth0>SW1:p2": 2, ...},
              "trace": [{"t": 0, "node": "PC1", "event": "arp-request", "detail": "who has 10.0.0.1? (try 1)"}, ...]}]}
```

- `frames`: frames sent on each cable direction during the action (`"A:if>B:if": n`). This is what the
  validators compare against Linux.
- `trace` (with `--trace`): every decision, in plain English, with simulated time in seconds.

`engine/tools/run_spec.mjs` prints the bare `actions` array (no envelope); the Python validators read it.

## Stability

Version 1 is stable: new optional keys and action types may be added; nothing is renamed or removed and no
default changes without bumping `version` (and `format`).
