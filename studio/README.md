# OpenPacketRouter Studio

A browser front end for the engine. Plain HTML, CSS and ES modules: no build step, no dependencies. The page
imports `engine/src` directly, so it always runs the same engine as the CLI and the Linux validators.

```bash
npm run studio                 # = python3 -m http.server 8640, from the repository root
open http://localhost:8640/studio/            # or ?lab=loop-no-stp to start on a lab
```

Serve the repository root (not `studio/`): the page loads `../engine/src/*.js` and `../examples/*/`.

## What it does

- **Load a network**: pick a lab from `examples/`, or open your own spec JSON (and an actions JSON) from disk.
  Problems with the spec are listed with their JSON path, the same messages as `openpacketrouter check`.
- **Map**: switches, routers, hosts and servers with their cables. Access ports are colored by VLAN, trunks are
  dashed and labeled with their VLANs. Switch ports carry a dot: green forwarding, orange listening/learning,
  red blocked (by spanning tree or the spec's `blocked` list). Drag devices to move them (saved in the browser).
- **Playback**: the actions run on the engine exactly as `runActions` runs them (each action on a cold network,
  then `settle`), so frame counts match the CLI. Every frame put on a cable is one step: play, pause, step
  back and forth (Space, ←, →, Home) and change the speed. Each step shows the frame and the engine's
  plain-English decisions that led to it. A loop that never ends is recorded up to 4000 frames.
- **Device panel**: click a device. Switches: MAC address table, spanning-tree roles and states, VLAN per port.
  Routers, hosts and servers: interfaces, routing table, ARP cache, and DHCP leases on a DHCP server. The tables
  show the moment of the current frame (or the network at rest, after spanning tree settles).
- **Storm badge**: the engine's storm math (`stormAnalysis`) on the network as cabled now: no loop (ρ = 0),
  broadcasts circulate (ρ = 1), or a storm (ρ > 1) with its growth rate and doubling time. A teaching model.
- **Cut a cable**: click it to unplug it (✂) and run everything again; click again to plug it back in.
- **Console**: double-click a device (or "Open console" in its panel) for a Cisco-style prompt: `R1>`, `enable`,
  `configure terminal`, `interface eth1`, `R1(config-if)#`. Words abbreviate to any unique prefix (`sh ip ro`),
  `?` lists what can come next, Tab completes, ↑/↓ recall history, Ctrl+Z ends configuration, `do` runs a
  show command from configuration mode. Configuration edits the spec and the network runs again; a change the
  spec check refuses is reported with its reason. `ping` and `traceroute` add their frames to the player.

  | Mode | Commands |
  |---|---|
  | `>` / `#` | `enable`, `disable`, `exit`, `configure terminal`, `show running-config`, `show ip interface brief`; routers and hosts: `show ip route`, `show arp`, `ping`, `traceroute`; switches: `show mac address-table`, `show spanning-tree`, `show vlan brief` |
  | `(config)#` | `hostname`, `interface`, `end`, `exit`; routers and hosts: `[no] ip route A.B.C.D MASK NEXTHOP`, `[no] ip default-gateway`; switches: `[no] spanning-tree`, `spanning-tree vlan 1 priority N` |
  | `(config-if)#` | `[no] shutdown`; routers and hosts: `ip address A.B.C.D MASK`, `ip address dhcp`; switches: `switchport mode access/trunk`, `switchport access vlan N`, `switchport trunk allowed vlan 10,20`, `switchport trunk native vlan N`, `spanning-tree cost N`, `spanning-tree port-priority N` |

  The commands come from `cli-stub.js`, a stand-in until the project has its own CLI package. Its interface is
  documented at the top of that file, so a real CLI can replace it.

## Files

| File | What |
|---|---|
| `index.html`, `style.css` | The page |
| `app.js` | Drawing, playback, panels, file loading |
| `sim.js` | Runs a spec + actions and records frames, reasons and device tables per step (no DOM; Node can import it) |
| `layout.js` | Automatic placement of devices |
| `cli-stub.js` | The console's command line (one session per device) |
| `examples.js` | Built-in list of labs (used until `examples/index.json` exists) |

Tests: `node tests/studio/smoke.mjs` (Playwright, headless Chromium) loads every lab, plays, steps, opens the
panels, cuts a cable and drives the console. It runs in CI.
