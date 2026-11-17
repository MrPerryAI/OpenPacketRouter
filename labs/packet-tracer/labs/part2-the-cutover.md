# Part 2: The Cutover

**Goal:** Perform the El Dorado copper-to-fiber cutover exactly as the work order says, and find out what one remote site can do to a whole country.
**Time:** About 45 minutes.
**Start from:** `faa-ftl-baseline.pkt` (Part 1), **saved**.

> ⚠️ **Save first.** Broadcast storms can make Packet Tracer slow or unresponsive. That's realistic, but annoying. Save before step 5 so you can reopen a clean copy.

## The work order

```
WORK ORDER  #FTI-ELD-0413                       Priority: Routine
Site:        El Dorado, AR  (remote radio site)
Task:        Migrate site from legacy copper circuit to new fiber.
             Replace legacy edge device with new edge device.
Procedure:
  1. Install new edge device ELD-NEW. Load standard remote-site
     template v2.3.
  2. Connect new fiber: ELD-NEW Gi0/1 to FTI core (NOC-SW Gi0/1,
     pre-provisioned).
  3. Prep legacy device for migration (open Fa0/23-24).
  4. Cross-connect ELD-NEW to ELD-OLD so services can be moved.
  5. Move services, then remove legacy copper circuit.
Notes:       Same template used successfully at Amarillo, TX (3 wks ago).
             Rollback plan: N/A - routine.
```

Before you touch anything, answer **worksheet Part 2, Q1 to Q3** (peer review and predictions).

## Steps

### 1. Install ELD-NEW
Place a **2960-24TT**, name it `ELD-NEW`, and paste
[`configs/2-cutover/ELD-NEW-vendor-template.txt`](../configs/2-cutover/ELD-NEW-vendor-template.txt).

### 2. Connect the new fiber
Cable row **14**: NOC-SW **Gi0/1** ↔ ELD-NEW **Gi0/1** (cross-over). Use the Note tool to label it `FIBER`.

Fast-forward time, then test `ZFW-VOICE → ping 10.200.0.50`. **Record the result.**

### 3. Prep the legacy device
On ELD-OLD, paste [`configs/2-cutover/ELD-OLD-migration-prep.txt`](../configs/2-cutover/ELD-OLD-migration-prep.txt).

### 4. Cross-connect A
Cable row **15**: ELD-NEW **Fa0/23** ↔ ELD-OLD **Fa0/23**.

Fast-forward time and test the same ping. **Record the result.**

> **Note:** Depending on your Packet Tracer version, the storm may already start here. That's because a loop now exists through the core: NOC-SW → ELD-NEW → ELD-OLD → ZME-SW → NOC-SW. If it does, jump to step 6 and come back to answer worksheet Q6.

### 5. Cross-connect B ("the spare")
The installer notices that cross-connect A's link light was slow to turn green, so they add a second cable "just in case."

Cable row **16**: ELD-NEW **Fa0/24** ↔ ELD-OLD **Fa0/24**.

**Save now** as `faa-ftl-cutover.pkt`.

### 6. Trigger it
A broadcast storm needs one broadcast to get started, and an ARP request is perfect.

1. On **ZFW-VOICE** → Command Prompt: `arp -d`. This clears its ARP cache, so the next ping must send a broadcast.
2. Switch to **Simulation** mode (bottom right).
3. **Edit Filters** → show only **ARP** and **ICMP**. Turn STP off in the filter so it doesn't clutter the view.
4. On ZFW-VOICE: `ping 10.200.0.50`
5. Press **Play** and watch the topology and the **Event List**.

### 7. Observe
Watch for the answers to these questions (worksheet Q4 to Q7):

- Where are the ARP envelopes going? Do they ever stop?
- Count events in the Event List after 10, 20, and 30 seconds. Is the count growing in a straight line, or faster?
- Which sites receive copies of the El Dorado broadcast? Does **Albuquerque**, 2 hops away, get them? Does **Amarillo**?
- Pick one envelope that's going around the ELD-NEW ↔ ELD-OLD loop and click it. Look at the Layer 2 frame. Is there anything in an Ethernet frame (like a TTL) that would eventually kill it?

Now switch back to **Realtime** mode and, from a *different* Center, try:

```
ZAB-RADAR> arp -d
ZAB-RADAR> ping 10.100.0.60
```

Record what happens. On real equipment, a storm uses up link bandwidth and switch CPU across every trunk carrying the looped VLANs, so radar traffic suffers too, even though the problem began with a voice-network broadcast at a radio site. Packet Tracer doesn't model bandwidth exhaustion very accurately, so your pings may still partly work. Describe what you see either way.

### 8. Connect it to the real event

| Real event (Nov 13, 2026) | Your simulation |
|---|---|
| Router replacement at El Dorado, AR radio site | ELD-NEW installed at El Dorado |
| Copper-to-fiber migration | Legacy copper (ZME) + new fiber (NOC) both live |
| "Data began flooding the FAA FTI network" | Broadcast frames multiplying with no end |
| 17 of 22 Centers unstable | ZFW, ZME, ZAB all affected |
| Amarillo, TX, upgraded weeks earlier, also involved | AMA-SW uses the same template and gets flooded too |
| Router maker: "functioned as it was configured" | ELD-NEW did exactly what its template said |

**Do not fix it yet.** Leave the storm running or reopen `faa-ftl-cutover.pkt`, then go to Part 3.
