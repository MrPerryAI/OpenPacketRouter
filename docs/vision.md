# Design ideas

These are working notes on what would make OpenPacketRouter different. Each idea has relatives in research. The combination, aimed at education with mixed detail levels, is the bet. A literature search should be done before claiming novelty anywhere formal.

## The problem

Full emulation is accurate but expensive: a single vendor virtual machine can need several GB of RAM, and a class of 25 needs a server room. Simulation is cheap but drifts from how real gear behaves. We want production-close behavior where it matters and cheap modeling everywhere else.

## 1. One behavior spec, several detail levels

Describe each device's behavior once, in a small purpose-built language built inside a host language such as Rust. Compile that description to different targets:
- **flow level:** traffic as rates, for background devices,
- **packet level:** for devices in focus,
- **check mode:** for proving properties, such as "no loop is possible."

Because every level shares the same state format, switching a device between levels is a translation, not a migration. Prior art: declarative networking (NDlog), Batfish, P4.

## 2. Storm math *(proof of concept #1, done)*

The spectral radius of the non-backtracking matrix classifies every broadcast loop from the layout alone. The renewal-equation growth rate and its eigenvector predict how fast a storm grows and where its traffic concentrates. Uses:
- simulate background regions without packets,
- flag dangerous loops before they happen, so the scheduler can promote those devices to full detail.

See `poc/storm-math`.

## 3. Graceful-restart handoff

When a device moves from simulated to real, use the failover mechanisms real routers already ship with (BGP and OSPF graceful restart). Stand-in neighbors replay the routing messages so the real router converges while the model keeps forwarding. Traffic cuts over only once the two agree, so the rest of the network never sees a disconnect.

## 4. Git-style shared state

Store network state as persistent data structures that share everything they have in common. Twenty-five students on the same scenario share one base copy, and each lab stores only its own changes. Fork and rewind become nearly free. Real devices get the same effect from container checkpoint and restore, plus the kernel's sharing of identical memory pages.

## 5. Vendor quirk layers

Model standard protocol behavior once. Capture each vendor's differences (default settings, timers, edge cases) as an add-on layer, found by automatically comparing against real vendor images.

## 6. Detail budget scheduler

Give each class or server a fixed detail budget. Spend it on the devices with the highest interest score:
- a student is working on the device,
- the scenario has pinned it,
- traffic through it looks unusual,
- the loop-risk number from idea 2 is high.

## Proofs of concept

1. **Storm math vs an independent packet simulator.** Done: `poc/storm-math`, every lab scenario.
2. **Storm math vs real Linux kernel bridges.** Done: `poc/storm-math/run_kernel.py`. Exact copy counts, circulating rates within 4%, and storm growth matching the simulator.

3. **Routers, clients and servers vs real Linux.** Done: `engine/` plus `validate/l3/`. Ping, traceroute, DNS, closed ports, unreachable hosts, a routing loop and a missing return route all match Linux frame for frame on every cable.

## Next

- **Spanning tree vs the kernel.** Turn on the kernel's own STP (`stp_state 1`) and check that the lab's spanning tree in `web/src/20-engine.js` blocks the same ports.
- **The handoff experiment (idea 3):** swap one switch between the model and a real bridge mid-traffic, and measure whether its neighbors notice.
- **Open vSwitch and a vendor image** (Nokia SR Linux or Arista cEOS in a container) as the next "real" references.
- **A second lab scenario** built on the same engine, so the lab becomes a platform rather than one story.
- **Move the lab onto the engine:** the Storm Lab's own switch-only engine (web/src/20-engine.js) becomes a client of `engine/`, so students can ping, traceroute and look things up, not just watch broadcasts.
- **Engine features next:** spanning tree, VLANs, TCP, DHCP, and OSPF. Each gets a Linux frame-for-frame validation before it ships.
