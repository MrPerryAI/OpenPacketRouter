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
  unplugs its cable, and `ping` and `traceroute` add their frames to the player. Commands: see `cli/README.md` and
  `docs/cli-design.md`.

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
| `layout.js` | Automatic placement of devices |
| `examples.js` | Built-in list of labs (used until `examples/index.json` exists) |

Tests: `node tests/studio/smoke.mjs` (Playwright, headless Chromium) loads every lab, plays, steps, opens the
panels, cuts a cable and drives the console. It runs in CI.
