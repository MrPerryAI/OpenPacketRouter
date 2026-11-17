# Teacher Guide and Answer Key

> Keep this folder away from students. Make the repo private, or delete `instructor/` from the copy students receive.

## At a glance

| | |
|---|---|
| Level | High school networking, intro CCNA (ITN/SRWE) |
| Prerequisites | Basic switch CLI, VLANs and trunks (Part 1 reviews them), what ARP does |
| Packet Tracer | 8.x recommended. 7.3 should work but hasn't been tested. |
| Concepts | VLANs, 802.1Q, broadcast domains, STP/RSTP, root bridge, PortFast, BPDU Guard, routers as broadcast boundaries, incident response, change management |
| Time | 4 to 5 periods of 45 minutes total. Each part works on its own. |

## Suggested pacing

| Day | Activity |
|---|---|
| 1 | Incident briefing and discussion (15 min). Part 1 build, or hand out the pre-built baseline (30 min). |
| 2 | Part 2: cutover and storm. Save time for Q4 to Q7. |
| 3 | Part 3: contain, diagnose, fix. Run a timed "NOC drill" if you like. |
| 4 | Part 4: routed redesign and re-break test. |
| 5 | Part 5: MOP writing and peer swap. Final discussion. |

**Short on time?** Hand out a pre-built `faa-ftl-cutover.pkt` with the storm one ping away. Run Part 2 steps 6 and 7 and Part 3 steps 1 to 3 in a single 45-minute period.

## Before class: do a test run (important)

These configs were written to Packet Tracer's CLI but **couldn't be tested in Packet Tracer when this repo was created**. Run the lab once yourself and check:

1. **Part 1:** every baseline ping succeeds, and NOC-SW reports "This bridge is the root."
2. **Part 2:** the storm appears by step 5 at the latest.
3. **Part 3:** after hardening, one cross-connect port shows BLK and the storm doesn't come back.
4. **Part 4:** the storm stays behind ELD-RTR.

If a command is rejected, it's usually a version difference. The most likely ones are `spanning-tree vlan N` (re-enable) and `interface range`. Type the lines one at a time or apply them per interface. Please commit any fixes back to the repo.

The quickest way to set up for the test run is the scripts in [`ptbuilder/`](../ptbuilder/README.md). They build all three `.pkt` files (baseline, cutover, final) in a few minutes. Commit them to `pkt/`. If a script reports a problem, it names the exact device, cable, or config, and you can fix that one item by hand.

### Managing Packet Tracer during a storm
- **Save before triggering.** A storm can make PT very slow.
- If PT bogs down, go to the CLI and `shutdown` ELD-NEW Fa0/23 and Fa0/24. This breaks the loop at once. You can also close without saving and reopen the saved file.
- In Simulation mode, filtering to **ARP + ICMP only** keeps the Event List readable.
- **Reset Simulation** clears queued events after containment.

### Why the storm might start at cross-connect A (Part 2, step 4)
After cross-connect A, a large loop exists: NOC-SW → ELD-NEW → ELD-OLD → ZME-SW → NOC-SW.
- On **real Cisco switches**, a switch with STP disabled still *forwards* BPDUs from its neighbors. NOC-SW and ZME-SW would see each other's BPDUs through El Dorado and block one port, so the big loop would be safe. The storm would then need cross-connect B, which creates a loop *only* between the two STP-disabled switches, where nothing is sending BPDUs to break it.
- **Packet Tracer** may or may not model BPDU pass-through the same way, so the storm can start one step early.

Either outcome is fine for teaching, and both make a good discussion: *"STP on the core can only protect you if it can see the loop."*

## Answer key

### Briefing
- **B1:** Router replacement and copper-to-fiber work at the El Dorado, AR radio site. The new device began flooding the FTI network with data. Radar and communications became unstable at 17 of 22 Centers.
- **B2:** Any two of: the protocol or traffic type of the flood; whether the cause was configuration, hardware, or installation; why Amarillo reacted; why safeguards didn't contain it.
- **B3:** Answers vary. Examples: one blown fuse vs. the whole building's breaker; one sick student vs. a whole school sharing one cafeteria line.

### Part 1
- **1.1:** ELD-OLD ("only one uplink, so a loop is impossible") and AMA-SW ("standard remote-site template v2.3: remote sites are single-homed").
- **1.2:** NOC-SW. `show spanning-tree vlan 200` says "This bridge is the root," and the Root ID equals the Bridge ID, with priority 4096 + 200 = 4296.
- **1.3:** It depends on MAC addresses. One end of each backup link shows `Altn BLK`. It's usually the switch with the higher bridge ID (higher MAC, since priorities tie).
- **1.4:** Redundancy: if a primary link fails, the backup takes over. One end must block because Ethernet frames have no TTL, so a loop would circulate frames forever.
- **1.5:** All ✔. The first ping may lose one reply while ARP resolves.

### Part 2
- **Q1:** The three `no spanning-tree vlan` lines. The comment's assumption ("remote sites are single-homed") is false *during a migration*, when the site temporarily has two uplinks plus cross-connects. A reviewer should also flag `Rollback plan: N/A`.
- **Q2:** Two uplinks (old copper to ZME and new fiber to NOC) plus two cross-connects between ELD-NEW and ELD-OLD. That creates several loops.
- **Q3:** Predictions vary. Reward reasoning.
- **Q4:** Copies multiply at every switch and loop around ELD-NEW ↔ ELD-OLD without end. Copies flood out every trunk to every Center.
- **Q5:** **It depends on which loops exist**, and this is a great discussion point. (Verified with the storm-math prototype against a packet simulator.)
  - **Only the El Dorado pair loops** (the core blocked the big loop, which is what real Cisco gear would likely do): one broadcast circulates forever but does **not** multiply. The event count grows in a straight line. The damage comes from **accumulation**: each new broadcast (and ARP traffic sends them constantly) adds another permanently looping frame. In the model, one broadcast used about half of every national link, and the second one filled them completely.
  - **The core can't see the big loop either** (Packet Tracer may behave this way): frames multiply every pass, and the count grows **exponentially**, doubling every couple of milliseconds in the model.
  
  Accept either answer if the student's observation supports it. Strong answers explain why: a frame multiplies only when it reaches a switch with *more than one* other looped path to leave on.
- **Q6:** IP decrements TTL at every router hop and drops the packet at 0, so a routing loop eventually ends. Ethernet frames have no TTL, so a switching loop lasts until the loop is physically or logically broken. That's why STP exists.
- **Q7:** Every switch carrying VLAN 200 (and the other looped VLANs): NOC, ZFW, ZME, ZAB, and AMA. Amarillo is flooded even though nothing changed there, which mirrors the real event, where Amarillo was also involved.

### Part 3
- **3.1:** Centers recover, and center-to-center plus Amarillo radar work again. El Dorado's radio is lost. Controllers lose the frequencies served by that site and would rely on backup sites or frequencies, possibly with reduced coverage.
- **3.2:**
  1. ELD-OLD had STP disabled years ago (**old** latent condition).
  2. ELD-NEW's template disabled STP (**new**, and also present at Amarillo).
  3. Both uplinks were left live and a "spare" second cross-connect was added (**today's decision**).
  
  Accept "no rollback plan or peer review" as an alternative third condition.
- **3.3:** It was built from the same flawed template. It's a loop waiting for a second cable. This mirrors the FAA disabling the broadcast function on all of the newly installed routers.
- **3.4:** The port on whichever switch has the worse (higher) bridge ID, and the higher port ID, usually Fa0/24. Accept any answer explained using bridge ID and port ID.
- **3.5:** Fa0/5 goes to **err-disabled** (shown in `show interfaces status`). Recover by removing the rogue switch, then `shutdown` and `no shutdown` on the port.
- **3.6:** No single right answer. Strong answers name *several* layers: the template's author and the missing review, a work order with no rollback plan, an installer adding an unplanned cable, and a design where one site shares a broadcast domain with the whole country. This links to the "Swiss cheese model" of accidents and to the HPE quote: the device "functioned as it was configured."

### Part 4
- **4.1:** 2 hops: (1) 10.200.0.20, the ELD-RTR FTI side, and (2) 172.16.20.10, ELD-RADIO.
- **4.2:** No. Routers don't forward Layer 2 broadcasts between interfaces. The broadcast domain ends at ELD-RTR Gi0/1.
- **4.3:**

  | | Original | Routed |
  |---|---|---|
  | Sites affected | All | El Dorado only |
  | Centers affected | All 3 | None |
  | El Dorado working? | No | No (its own LAN is still storming) |
- **4.4:** Any of: cost, more devices to manage, IP readdressing, legacy systems that expect Layer 2 adjacency, or more complex troubleshooting.

### Part 5
Grade with the checklist in the handout. Strong MOPs:
- Fix the template first: STP on, BPDU Guard on host ports, and storm control on real hardware.
- Bring up the fiber **with the copper uplink shut**, or move services before adding any cross-connect.
- Use **one** cross-connect, and check `show spanning-tree` for a BLK port before adding anything else.
- Name triggers, such as event flood, ping loss from any Center, rising interface counters, or STP topology changes, with "pull cross-connect / shut Gi0/1" as the first rollback action.
- Notify the Centers before the window starts.
- Schedule the work for a low-traffic window.
- Fix Amarillo *first*, then roll out the template one site at a time as a canary.

**5.2:** Opinions vary. Strong answers mention traffic levels, staffing, and whether a full rollback can be done quickly. Note: public reporting hasn't said exactly why the work happened when it did. Don't present a specific claim about the timing decision as fact.

## Discussion prompts

1. *"Working as configured" vs. "broken."* HPE says the router didn't fail. Is that a fair defense?
2. Why might a router in Texas react to a change in Arkansas? Brainstorm possibilities. The real answer isn't public yet, so this is about reasoning, not facts.
3. The FAA disabled a feature on *all* of the newly installed routers after the incident. Is a fleet-wide change after an incident risky too? How would you make it safe?
4. Secretary Duffy has asked Congress for $50 billion to modernize air traffic control. Based on this lab, what would you spend money on first: new equipment, network redesign, or training and process?

## Extensions
- **EtherChannel:** bundle the two cross-connects with LACP so the "spare" cable *adds* bandwidth instead of creating a loop.
- **Root guard:** put `spanning-tree guard root` on NOC-SW and ZME-SW site-facing ports. What happens if a remote switch tries to become root?
- **Routing protocols:** extend Part 4 by routing at every site with OSPF and observe how failures stay contained.
- **Careers:** FAA Technical Operations, NOC engineer, telecom field technician. What would a day like Nov 13 be like in each role?

## Accuracy notes for teachers
- This lab models the flood as a Layer 2 **broadcast storm**. As of Nov 17, 2026, officials haven't said what protocol was involved. Present the lab as an analogy, as the student briefing does.
- Center assignments (ZME for El Dorado, ZAB for Amarillo) are simplified for the lab.
- Check for updates before teaching. An official preliminary report may change the details.
