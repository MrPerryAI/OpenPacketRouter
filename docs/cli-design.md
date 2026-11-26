# Device CLI design (`cli/`)

A free, open command line for routers and switches, in the style network engineers already know, that
works on the OpenPacketRouter engine first and on real open routers (Linux, FRRouting, OpenWrt) next.
It is a library first (any simulator or router can embed it) and a terminal program second.
License: Apache-2.0, like the rest of the repository.

Not to be confused with `engine/bin/openpacketrouter.mjs`, the tool that runs a spec and its actions. This
document is about the *device* CLI: the prompt you get when you open a console on R1.

## Goals

1. **Familiar.** Modes, prompts, abbreviations, `?` and Tab behave the way people who learned on
   industry gear expect. Routing commands follow FRRouting's style (`ip route 10.2.0.0/24 10.0.0.2`,
   `router rip`, `network 10.0.0.0/8`); switching commands follow the common industry style
   (`switchport mode access`, `switchport access vlan 10`, `vlan 10` / `name STAFF`, `spanning-tree`).
2. **Data-driven.** Every command is a definition in a JSON file under `cli/commands/`. Adding a command
   means adding a definition and, if it needs new behaviour, one handler function. The parser, `?` help,
   Tab completion and error messages come from the definitions; nothing is hand-coded per command.
3. **One model, many backends.** Commands never touch a backend directly. They edit a configuration
   *model* shaped like OpenConfig; a backend turns the model into something real.
4. **Automation-ready.** Every `show` command accepts `| json`. `show running-config` prints commands
   that rebuild the same device when replayed (a round-trip test enforces it). The terminal program
   takes commands from arguments or stdin, so scripts and CI can drive it.
5. **Clean-room.** We write our own command definitions, help text, messages and code. We never copy
   Cisco IOS code, documentation or help text, and never copy FRRouting code or text (FRR is GPL).
   Command *names* that are an industry convention (`interface`, `ip address`, `switchport`) are used
   as conventions. Command definitions from the SONiC management framework (Apache-2.0) may be adapted;
   anything adapted is listed in `NOTICE` with its source.

## Architecture

```
 keyboard / script / studio console
            │  text
            ▼
 ┌─────────────────────────┐   cli/commands/*.json  (definitions: syntax, help, modes, handler name)
 │ session (modes, prompt) │◄──────────────────────
 │ parser  (?, Tab, abbrev)│
 └───────────┬─────────────┘
             │ handler(name, args)
             ▼
 ┌─────────────────────────┐
 │ configuration model     │  OpenConfig-shaped JSON: system, interfaces, network-instances,
 │ (+ operational state)   │  stp, relay-agent, openpacketrouter extensions
 └───────────┬─────────────┘
             │ getConfig / setConfig / state / run
   ┌─────────┼──────────────┬──────────────────┬───────────────┐
   ▼         ▼              ▼                  ▼               ▼
 engine    Linux          FRRouting          OpenWrt         (yours)
 (spec)    iproute2 +     frr.conf /         UCI
           bridge         vtysh
```

- **Session** keeps the mode, the selected interface (or VLAN, pool, routing process), the prompt and
  the history. `exec(line)`, `help(line)` and `complete(line)` are the whole interface a front end needs.
- **Parser** matches typed words against the definitions for the current mode.
- **Handlers** are small functions keyed by name (`interface.ipv4.address.set`). Each one receives a copy
  of the model and the parsed arguments and returns the changed model. The session hands the new model
  to the backend; if the backend refuses it (for example, the engine's spec validator finds a gateway
  that is not on any subnet), the session prints the reason and keeps the old model. Every command is
  all-or-nothing.
- **Backends** implement one small interface (below). The engine backend is complete; the others start
  as stubs that can at least render a model, and each gets one working proof against a real system.

## Modes

| Mode | Prompt | Entered with | Left with |
|---|---|---|---|
| user | `R1>` | session start | `exit` (closes) |
| privileged | `R1#` | `enable` | `disable`, `exit` |
| config | `R1(config)#` | `configure terminal` | `exit`, `end`, Ctrl-Z |
| interface | `R1(config-if)#` | `interface eth0` | `exit` (to config), `end` |
| router | `R1(config-router)#` | `router rip` (RIP lands after RIPv2) | `exit`, `end` |
| vlan | `SW1(config-vlan)#` | `vlan 10` | `exit`, `end` |
| dhcp pool | `R1(config-dhcp)#` | `ip dhcp pool LAN` | `exit`, `end` |

- User mode allows `show` (status only, no `show running-config`), `ping`, `traceroute` and `enable`.
- In any configuration mode, `do <command>` runs a privileged command without leaving the mode.
- A configuration-mode command that is not defined in a sub-mode but is defined in config mode
  (for example `interface eth1` typed while in `config-if`) is run in config mode and moves you there,
  as people expect.
- Which commands exist depends on the device kind the backend reports (`router`, `switch`, `host`,
  `server`): switching commands only on switches, routing and IP services only on IP devices.

## Command definition files

`cli/commands/<feature>.json`, one file per feature, all loaded at start (a front end may load a subset).

```json
{
  "feature": "ip-static",
  "commands": [
    {
      "modes": ["config"],
      "kinds": ["router", "host", "server"],
      "syntax": "ip route PREFIX NEXTHOP",
      "args": {"PREFIX": "ipv4-prefix", "NEXTHOP": "ipv4-address"},
      "help": {"ip": "IPv4 settings", "route": "Add a static route", "PREFIX": "Destination network",
               "NEXTHOP": "Next-hop router address"},
      "handler": "static.add"
    },
    {
      "modes": ["config"], "kinds": ["router", "host", "server"],
      "syntax": "no ip route PREFIX NEXTHOP",
      "args": {"PREFIX": "ipv4-prefix", "NEXTHOP": "ipv4-address"},
      "help": {"no": "Remove a setting"}, "handler": "static.remove"
    }
  ]
}
```

- `syntax`: words separated by spaces. Lower-case words are keywords; UPPER-CASE words are arguments
  whose type is in `args`. Alternatives are separate definitions (simple to read, simple to match).
- `help`: one short line per word, written by us. When two definitions share a keyword at the same
  position, the first help text wins, so a keyword is explained once.
- `handler`: the name of a function in `cli/src/handlers.js` (config) or `cli/src/show.js` (show).
  `show` handlers return `{text, json}`, so `| json` works for every show command by construction.
- `kinds`, `modes`: where the command exists. `enter`: the mode the command moves to (`"config-if"`).
- Argument types (`cli/src/types.js`): `ipv4-address`, `ipv4-prefix` (`A.B.C.D/M`), `ipv4-mask`,
  `uint:LOW-HIGH`, `vlan-id`, `vlan-list` (`10,20,30-40`), `word`, `ifname` (completed from the
  backend's real interface names), `rate` (`1mbit`), `mac`, `line` (rest of the line).

A file format check runs in the tests: every definition parses, every handler exists, every keyword
has help, and no two definitions in one mode have the same syntax.

## Help, completion and abbreviations (Klish-style)

- **`?` after a space** lists what can come next, one per line with its help, plus `<cr>` when the
  command is already complete. **`?` right after letters** (`sh?`) lists the keywords that start with them.
- **Tab** completes the current word when only one keyword fits; otherwise it extends to the longest
  common prefix and lists the choices. Interface names complete from the backend.
- **Abbreviations:** any unique prefix of a keyword is accepted (`conf t`, `sh ip ro`, `int eth0`).
  Interface names accept a unique prefix too.
- **Errors** point at the word: `% Unknown word at '^'`, `% Command is incomplete`,
  `% Ambiguous: "s" could be show, shutdown`. Messages are our own wording.

## Output pipes

Any `show` command may end with a pipe:

- `| json` — the same data as JSON (one object, stable keys, documented per command in
  `docs/cli-reference.md`). `show running-config | json` prints the configuration model itself.
- `| include WORD`, `| exclude WORD` — keep or drop lines that contain WORD.

## The configuration model

The model is the contract between commands and backends. It follows OpenConfig's tree and leaf names so
that a gNMI/NETCONF front end, or an OpenConfig-speaking router, can be added later without changing
commands. Keyed lists are stored as objects keyed by the list key (easier to edit); `toOpenConfig()`
converts to the standard JSON encoding (RFC 7951 lists) for export.

```json
{
  "system": {"config": {"hostname": "R1"}},
  "interfaces": {"interface": {
    "eth0": {"config": {"name": "eth0", "enabled": true},
             "subinterfaces": {"subinterface": {"0": {"ipv4": {
               "addresses": {"address": {"10.0.0.1": {"config": {"ip": "10.0.0.1", "prefix-length": 24}}}},
               "config": {"dhcp-client": false}}}}},
             "ethernet": {"switched-vlan": {"config": {"interface-mode": "ACCESS", "access-vlan": 10}}},
             "openpacketrouter:shaper": {"rate": "1mbit", "burst": 3000, "limit": 4000}}}},
  "network-instances": {"network-instance": {"default": {
    "protocols": {"protocol": {"STATIC": {"static-routes": {"static": {
      "10.2.0.0/24": {"next-hops": {"next-hop": {"10.0.0.2": {"config": {"next-hop": "10.0.0.2"}}}}}}}}}},
    "vlans": {"vlan": {"10": {"config": {"vlan-id": 10, "name": "STAFF"}}}}}}},
  "stp": {"global": {"config": {"enabled-protocol": ["STP"], "bridge-priority": 4096}},
          "interfaces": {"interface": {"p1": {"config": {"cost": 19, "port-priority": 128}}}}},
  "relay-agent": {"dhcp": {"interfaces": {"interface": {"lan": {"config": {"helper-address": ["10.0.0.1"]}}}}}},
  "openpacketrouter:services": {"dns": {...}, "dhcp-server": {...}, "tcp": {...}}
}
```

Things OpenConfig has no model for (the engine's DNS, DHCP server and TCP echo services, link shaping)
live under `openpacketrouter:` keys, so they never clash with a future OpenConfig module.

Operational state (`show ip route`, `show arp`, `show mac address-table`, `show spanning-tree`) is not
part of the configuration model; backends return it from `state(device)` in plain JSON that the show
handlers format.

## Backend interface

```js
{
  kind(device)             // "router" | "switch" | "host" | "server"
  ports(device)            // interface names that exist (for completion and checks)
  getConfig(device)        // -> model
  setConfig(device, model) // -> [] or ["reason it was refused", ...]; applies all or nothing
  state(device)            // -> {interfaces, routes, arp, mac, stp, vlans} (each optional)
  run(device, tool, args)  // ping / traceroute -> result (optional)
  rename(device, newName)  // hostname (optional)
  save()                   // write memory (optional)
}
```

### (a) Engine backend — first, complete

`cli/src/backends/engine.js` maps the model to one node of a spec (`docs/spec-format.md`) and back:
interface addresses to `ifaces`, static routes to `routes` (the default route to `gw`), switchport
settings to `vlans`, spanning tree to `stp`, `shutdown` on a switch port to `blocked`, shaping to the
cable's `shape`/`shapeBack`, DHCP relay to `services.dhcpRelay`, and the services to `services.*`.
`setConfig` runs the engine's own spec validator, so the CLI can never produce a spec the engine
rejects. When the CLI needs something the spec cannot say yet (VLAN names, for example), the spec
grows a key through the usual `registerNodeKeys` route, documented in `docs/spec-format.md`.

Running the engine needs no root, so this backend is what Studio's console and the tests use.

### (b) Linux backend — iproute2 and bridge

Renders the model as the commands that build it on a Linux box: `ip link`, `ip addr`, `ip route`,
`bridge vlan`, `ip link set … type bridge stp_state 1`, `tc qdisc … tbf`. These are the same commands
the validators in `validate/` already use, so the proof is that a model rendered this way builds a
network that the existing Linux validators accept. Starts as a renderer only (no reading back).

### (c) FRRouting backend

Renders routing configuration (static routes, RIP, later OSPF) as `frr.conf` text and can apply it with
`vtysh -f`. Starts as a renderer; the proof is the RIPv2 validation that runs real `ripd`.

### (d) OpenWrt backend

Renders `network`, `dhcp` and switch/bridge-VLAN sections as UCI batch commands (`uci set …`). Starts
as a renderer; the proof is applying it in an OpenWrt container.

## `show running-config` round trip

For every device of every spec in `examples/` and `validate/`:

1. Print `show running-config`.
2. Start a blank device of the same kind with the same cabled ports.
3. Replay every line in configuration mode.
4. The resulting spec node (and its cables' shaping) must equal the original.

`cli/test/roundtrip.test.js` does this, so a new spec feature without a matching command, or a
command that forgets to print itself, fails CI.

## Package

```
cli/
  README.md            how to embed it, how to add a command, how to add a backend
  package.json         @openpacketrouter/cli, ES modules, no dependencies
  commands/*.json      command definitions
  src/index.js         createSession, loadDefinitions, engineBackend, …
  src/parser.js        definitions → matcher, help, completion
  src/types.js         argument types
  src/session.js       modes, prompt, pipes, do
  src/handlers.js      configuration handlers (model in, model out)
  src/show.js          show handlers ({text, json})
  src/render.js        running-config text from a model
  src/backends/        engine.js, linux.js, frr.js, openwrt.js
  bin/opr-cli.mjs      terminal program
  test/                parser, help/completion, round trip, pipes, backends
```

Terminal program:

```bash
node cli/bin/opr-cli.mjs examples/vlans/spec.json SW1                    # interactive console on SW1
node cli/bin/opr-cli.mjs examples/vlans/spec.json SW1 -c "show vlan brief | json"
printf 'conf t\ninterface p3\nswitchport access vlan 20\nend\nwrite\n' | node cli/bin/opr-cli.mjs lab.json SW1
```

## Roll-out

1. This design, `cli/` with the parser, modes, help/completion, pipes, the engine backend, the base
   commands (hostname, interfaces and addresses, static routes, switchport access/trunk, spanning tree,
   the engine's services, ping/traceroute and the show commands), and the round-trip test.
2. Studio's console uses `cli/` instead of its stub.
3. More switching commands (VLAN names, spanning-tree detail), RIP commands after RIPv2 lands.
4. `docs/cli-reference.md`: every command, generated from the definition files where possible.
5. One working proof per real backend: Linux first (checked in the Docker validator), then FRR, then
   OpenWrt. Linux: done for routers, hosts and plain switches (`validate/cli/`, 12/12 frame-for-frame matches).

## VRRP wording

The commands live on the interface and keep to our own vocabulary: `vrrp <group> address <ip>`, `priority`, `interval <seconds>`, `virtual-mac`, and `no vrrp <group> preempt` to stop a recovered higher-priority router taking over again. We chose `address` (it is the virtual address clients use as their gateway) and spelled-out `virtual-mac` rather than copying vendor keywords. The protocol terms (group, priority, master, backup, preempt) stay because they come from RFC 3768, not from any one vendor. `show vrrp` prints one row per group with the live state taken from the engine; `| json` gives the same rows.
