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

## Suggested next proofs of concept

1. **Compare the storm math against real Linux bridges or Open vSwitch**, not just our own simulator.
2. **Compute spanning tree port roles** instead of taking them as inputs. The browser lab already has a simplified STP; port it into the Python core and test it.
3. **The handoff experiment (idea 3):** swap one router between a model and real FRRouting mid-traffic and measure whether the neighbors notice.
