# @openpacketrouter/cli

A free, open command line for routers and switches. It behaves the way people who learned on industry gear
expect — modes, prompts, abbreviations, `?` help, Tab completion — and it is built for automation:
every `show` command takes `| json`, and `show running-config` prints commands that rebuild the device.

It is a library first. The commands live in data files, edit an OpenConfig-shaped configuration model, and a
*backend* applies that model somewhere: the OpenPacketRouter engine today, and Linux, FRRouting and OpenWrt
next. Another simulator or router can embed it by writing one backend. Design: [docs/cli-design.md](../docs/cli-design.md).
No dependencies, plain ES modules, Node 22+ or any current browser. License: Apache-2.0.

## Try it

```bash
node cli/bin/opr-cli.mjs examples/routed-lan-dns/spec.json R1          # a console on R1 (? for help, Tab, exit)
```

```text
R1>enable
R1#show ip route
Codes: C = connected network, S = static route

C  10.0.0.0/24 on eth0 (directly connected)
C  10.1.0.0/24 on eth1 (directly connected)
R1#configure terminal
R1(config)#ip route 10.9.0.0/16 10.1.0.53
R1(config)#end
R1#show ip route | json
[{"prefix": "10.0.0.0/24", "protocol": "connected", "interface": "eth0"}, …]
R1#ping 10.1.0.53
Reply from 10.1.0.53: time 8 ms
```

For scripts:

```bash
node cli/bin/opr-cli.mjs lab.json SW1 -c enable -c "show vlan brief | json"         # print each command and its output
node cli/bin/opr-cli.mjs lab.json SW1 --json -c enable -c "show spanning-tree"     # one JSON array
printf 'enable\nconf t\ninterface p3\nswitchport access vlan 20\nend\nwrite\n' | node cli/bin/opr-cli.mjs lab.json SW1
node cli/bin/opr-cli.mjs lab.json R1 --render linux                                # the same config as iproute2 commands
```

`write` saves the changed spec back to the file. Exit code 1 means a command was refused (the reason starts with `%`).

## Commands

| Mode | Prompt | Commands |
|---|---|---|
| user | `R1>` | `enable`, `show …` (not the configuration), `ping`, `traceroute`, `exit` |
| privileged | `R1#` | every `show` (`running-config`, `running-config openconfig`, `version`, `ip interface brief`, `ip route`, `arp`, `ip dhcp binding`, `mac address-table`, `spanning-tree`, `vlan brief`), `configure terminal`, `write`, `ping`, `traceroute`, `disable` |
| config | `R1(config)#` | `hostname`, `interface IFNAME`, `ip route PREFIX NEXTHOP` (or `NETWORK MASK NEXTHOP`), `ip default-gateway`, `spanning-tree` and its `priority / hello-time / max-age / forward-time / bridge-address`, `ip dns server`, `ip host NAME ADDRESS`, `ip dhcp pool NAME`, `service tcp-echo PORT` |
| interface | `R1(config-if)#` | `ip address A.B.C.D/M` (or `A.B.C.D MASK`, or `dhcp`), `shutdown`, `description`, `ip helper-address`, `shape rate R burst B limit L`, `switchport mode access/trunk`, `switchport access vlan N`, `switchport trunk allowed vlan LIST`, `switchport trunk native vlan N`, `spanning-tree cost / port-priority` |
| DHCP pool | `R1(config-dhcp)#` | `range FIRST LAST`, `default-router`, `dns-server`, `lease SECONDS`, `netmask` (for a relayed network's pool) |

`no …` undoes each setting. In any configuration mode, `do <command>` runs a privileged command; a config-mode
command typed in a sub-mode runs there and leaves the sub-mode. Which commands exist depends on the device:
switching commands on switches, IP commands on routers, hosts and servers. The full reference is
`docs/cli-reference.md`. Routing commands follow FRRouting's style; switching commands the common industry style.

## Embed it

```js
import {createSession} from "./cli/src/index.js";
import {engineBackend} from "./cli/src/backends/engine.js";

const backend = engineBackend(spec);                     // or engineBackend({spec: () => mine, setSpec, cut, setCut, run, state})
const s = createSession(backend, "R1");
s.prompt();                                              // "R1>"
s.exec("enable");                                        // {output, changed: null | "spec" | "actions", json?}
s.help("show ip ?");                                     // what can come next, with help
s.complete("sh ip ro");                                  // {line: "sh ip route ", options: ["route"]}
```

`changed` tells a front end what to redraw: `"spec"` after a configuration change, `"actions"` after `ping` or
`traceroute`. Every configuration command is all-or-nothing: if the backend refuses the new configuration (the
engine's spec validator finds a problem the spec did not have before), the old one stays and the reason is
printed. Settings the spec cannot hold yet (a DHCP pool before its range, an interface with no address) stay
visible in `show running-config` until the spec is changed from elsewhere.

## Add a command

1. Add a definition to a file in `commands/` (or a new file, listed in `commands/index.js`):
   ```json
   {"modes": ["config"], "kinds": ["router"], "syntax": "ip route PREFIX NEXTHOP",
    "args": {"PREFIX": "ipv4-prefix", "NEXTHOP": "ipv4-address"},
    "help": {"ip": "IPv4 settings", "route": "Add a static route"}, "handler": "static.add"}
   ```
   Lower-case words are keywords, UPPER-CASE words are typed arguments (types in `src/types.js`). `enter` moves
   to a sub-mode. A handler name may carry a parameter: `"stp.set:hello-time"`.
2. Write the handler in `src/handlers.js` (it edits a copy of the model) or, for a show, in `src/show.js`
   (it returns `{text, json}`).
3. Print it in `src/render.js` so `show running-config` includes it, and map it in the backend
   (`src/backends/engine.js`: model ↔ spec).
4. `npm test`: the definition checks, and the round trip over every spec in `examples/` and `validate/`,
   tell you what is missing. Write help text in your own words: never copy Cisco IOS or FRRouting text.

## Add a backend

Implement `kind(device)`, `ports(device)`, `getConfig(device)` → model, `setConfig(device, model)` → `[]` or
reasons, and optionally `state(device)`, `run(device, action)`, `save()`, `canCreatePorts(device)`. The model is
described in [docs/cli-design.md](../docs/cli-design.md); `model.toOpenConfig()` gives the standard OpenConfig JSON.
`src/backends/linux.js`, `frr.js` and `openwrt.js` are renderers today (model → iproute2/bridge/tc/dnsmasq
commands, `frr.conf`, UCI); each gets one working proof against a real system.

## Tests

```bash
cd cli && npm test     # definitions, parser and session, | json on every show, backends, the terminal program,
                       # and the running-config round trip on every device of every spec in the repository
```
