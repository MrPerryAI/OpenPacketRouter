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
| `ifaces` | Routers/hosts/servers: interface name → `"a.b.c.d/len"`, or `"dhcp"` for an interface that gets its address from a DHCP server. Switch ports are created by `links`. |
| `gw` | Default gateway. Must be on one of the node's subnets. |
| `routes` | Static routes: `[["10.2.0.0/24", "10.0.0.2"], …]`. The next hop must be on one of the node's subnets. |
| `services.dns` | A DNS server on UDP 53: name → IPv4 address. |
| `services.dhcp` | A DHCP server on the node's subnet: `{"range": ["first", "last"], "lease": 3600, "router": "ip", "dns": "ip"}`. `lease` is seconds (default 3600); `router` and `dns` are optional. The first address of the range must be on one of the node's subnets. |
| `services.tcp` | A TCP server: `{"7": "echo"}` listens on port 7 and echoes what it receives. |
| `blocked` | Switches: ports that drop everything. A manual override; spanning tree (`stp`) blocks ports by itself. |
| `stp` | Switches: turns on spanning tree. Optional fields: `priority` (default 32768), `mac`, `hello` (2 s), `maxAge` (20 s), `forwardDelay` (15 s), `cost` (`{"p1": n}`), `portPriority` (`{"p1": n}`). Timers are in seconds, the 802.1D defaults in brackets. |
| `vlans` | Switches: makes the switch VLAN-aware. Per port: `{"access": 10}` or `{"trunk": [10, 20], "native": 1}`. Ports not listed are access VLAN 1. |
| `links[]` | Cables: `["node:iface", "node:iface", delayMs?, {shape?, shapeBack?}?]`. Delay defaults to 1 ms. Each end may be cabled once. `shape` limits the egress of the first end and `shapeBack` the second: `{"rate": "1mbit", "burst": 3000, "limit": 4000}` (bytes for burst and queue). Modeled on the Linux `tbf` qdisc: rate is the link's capacity, burst is how much may leave back to back, limit is the queue; frames that overflow it are dropped. |

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
| `dhcp` | `src` | `iface` (default: the first interface marked `"dhcp"`), `tries` (3), `interval` (1 s). Runs a DHCP client; the result is the address, server and lease. |

Every action also takes `settle` (seconds to let frames in flight land after the answer, default 1).
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
