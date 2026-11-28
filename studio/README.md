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
- **Console**: double-click a device (or "Open console" in its panel) for the project's CLI (`cli/`, Apache-2.0) on
  that device: `R1>`, `enable`, `configure terminal`, `interface eth1`, `R1(config-if)#`. Words abbreviate to any
  unique prefix, `?` lists what can come next, Tab completes, ↑/↓ recall history, Ctrl+Z ends configuration, `do`
  runs a show command from configuration mode, and `| json`, `| include`, `| exclude` filter show output. Show
  commands read the tables at the current frame. Configuration edits the spec through the CLI's engine backend and
  the network runs again; a change the spec check refuses is reported with its reason. `shutdown` on an interface
  unplugs its cable, and `ping` and `traceroute` add their frames to the player. Each device you open gets its own tab (own history and mode); ✕ on a tab closes it. Commands: see `cli/README.md` and
  `docs/cli-design.md`.

- **Topology editor**: the toolbar above the map adds a switch, router, host or server. The *Cable* tool joins two
  devices (click one, then the other) on the next free ports; the *Delete* tool removes a cable or a device (with its
  cables); *Select* is the usual mode. The device panel has an *Edit* form: hostname (cables follow a rename),
  interface addresses (`10.0.0.1/24` or `dhcp`), default gateway, and for a switch the VLAN of each port (`10` for
  access, `trunk 10,20 native 1`). Every edit goes through the same spec validator as `openpacketrouter check`; one it
  refuses is reported with its path and nothing changes. Actions that no longer fit the network are dropped.
  The pure edit functions live in `editor.js`.
- **Save and export**: *Save spec* downloads the network as spec JSON (what the editor and the console changed),
  *Save actions* the actions; *Open spec…* reads such a file back. Every change is also autosaved in the browser's
  storage (a failure to save is ignored); *Restore autosave* appears in the header when one exists. *Save YAML* downloads the spec as YAML;
  *Open spec…* and *Open actions…* read `.yaml`/`.yml` as well as JSON.

- **Feature panels** (in the device panel, at the current frame): RIP and RIPng routes (RIPng frames get their own filter); OSPF neighbors, interfaces and routes;
  NAT translations with time left; ACL rules with **hit counts** (Studio counts them: it wraps each router's ACL check
  during the run, the engine keeps no counters); LLDP neighbors; on switches the MAC table with each entry's age and
  time left before it ages out (plus the aging time, shortened by a topology change), and port-channel (LACP)
  members with link, mux and partner state. At rest, Studio now runs long enough for OSPF, RIP and LLDP to settle.
- **IPv6, DHCP snooping, lossy cables, HTTP, OSPF areas**: the device panel lists a device's IPv6 addresses, routes and
  neighbor cache (filled by neighbor discovery); IPv6 frames get two filters, *ICMPv6* and *IPv6 ND* (neighbor solicitation
  and advertisement), and the event list describes them. A switch with `dhcpSnooping` shows its trusted ports and how many
  DHCP server messages each port dropped. A cable with a loss model is drawn dotted, and an action that lost frames on it
  says how many in the action list (a lost frame never reaches the wire, so it has no playback step). A TCP segment that
  carries an HTTP request or response names its first line. The OSPF panel shows the router's areas (and says when it is
  an area border router), each interface's area, and marks routes as intra-area or inter-area.
- **TCP window**: a segment from a limited-buffer receiver names the window it advertises ("window 0 B (full: the sender
  must wait)" for a zero window), so a stall and its window update can be followed frame by frame.
- **Services**: a router, host or server that runs the syslog receiver or the NTP server gets a
  *Services* section in its device panel: the stored syslog messages, and the NTP stratum with how many queries it has
  answered, at the current playback frame.
- **TCP**: a host with TCP connections gets a *TCP connections* table (endpoints, state, unacked segments, bytes queued, the peer's window, retransmits (retx)) at the current playback frame.
- **VRRP**: a router in a VRRP group gets a *VRRP* table in its device panel (interface, vrid, virtual IP, priority, MASTER/BACKUP/FAULT, and the current master's address) at the current playback frame.
- **Playback filters and event list**: under the map, one checkbox per protocol that appears in the run (ARP, ICMP,
  TCP, UDP, DHCP, DNS, STP, LACP, RIP, OSPF, LLDP) with its frame count. Unchecked protocols are skipped when you
  play or step, and leave the **Event list** in the side panel (like Packet Tracer's simulation mode: one row per
  frame with time, protocol, from → to and a description; click a row to jump to that frame). Studio now describes
  OSPF, RIP and LLDP frames (it used to fail on them).
- **Keyboard and phones**: Tab moves between devices and cables (a skip link jumps to the map). On a device: Enter or
  Space selects, **C** opens its console, arrow keys move it (Shift for bigger steps), Escape clears the selection;
  Enter on a cable unplugs or plugs it. Escape closes the console. Player buttons and the frame counter are labelled
  for screen readers; animation stops under *reduce motion*. Under 700 px wide the page is one column, the console
  fills the width, tables scroll sideways and buttons are touch sized.

## Files

| File | What |
|---|---|
| `index.html`, `style.css` | The page |
| `app.js` | Drawing, playback, panels, file loading |
| `sim.js` | Runs a spec + actions and records frames, reasons and device tables per step (no DOM; Node can import it) |
| `editor.js` | Pure spec edits behind the topology editor (add/remove devices and cables, rename, addresses, VLANs) |
| `layout.js` | Automatic placement of devices |
| `examples.js` | Built-in list of labs (used until `examples/index.json` exists) |

Tests: `node tests/studio/smoke.mjs` (Playwright, headless Chromium) loads every lab, plays, steps, opens the
panels, cuts a cable and drives the console. For every lab it also checks that each frame has a description without
`undefined`/`NaN`, that each frame kind has a filter checkbox, and that every device panel opens at the last frame. It runs in CI.

- **Student guide**: choosing an example lab shows its `README.md` in a "Student guide" box at the top of the side column (hidden when
  the lab has none). It is rendered by `guide.js`, a small Markdown subset: raw HTML never reaches the page and only relative links
  stay links. A command in backticks or a code block that starts with `show`, `ping` or `traceroute` gets a "▶ run on R" button that
  opens that device's console tab and runs it. The device is the last one the text names ("On R: ...", `R`, **R**), else the first router.

A walk-through with pictures for teachers and students is in [docs/studio-guide.md](../docs/studio-guide.md).
