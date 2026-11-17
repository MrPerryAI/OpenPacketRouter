# Student Worksheet: One Router, 12,000 Flights

Name: ______________________  Partner(s): ______________________  Date: __________

---

## Before the lab: Incident briefing

Read [docs/incident-briefing.md](../docs/incident-briefing.md).

**B1.** In your own words, what triggered the November 13 ground stop?

&nbsp;

**B2.** List two things investigators *still* don't know.

&nbsp;

**B3.** What is a "failure domain"? Give an example from everyday life, not from networking.

&nbsp;

---

## Part 1: Build FTI-lite

**1.1** Which two devices have spanning tree turned off? What reason does each config give?

| Device | Reason in the config |
|---|---|
| | |
| | |

**1.2** Which switch is the root bridge for VLAN 200? What in `show spanning-tree` proves it?

&nbsp;

**1.3** Fill in the blocked ports on the backup links:

| Backup link | Blocking port (switch + interface) |
|---|---|
| ZFW–ZME | |
| ZME–ZAB | |

**1.4** Why does the network need those backup links at all? And why must one end be blocked?

&nbsp;

**1.5** Baseline ping results (✔ / ✘):

| Test | Result |
|---|---|
| ZFW-RADAR → 10.100.0.60 | |
| ZME-RADAR → 10.100.0.60 | |
| NOC-MON → 10.100.0.13 | |
| ZFW-VOICE → 10.200.0.50 | |
| ZAB-VOICE → 10.200.0.50 | |

---

## Part 2: The Cutover

**Q1. Peer review.** Read `ELD-NEW-vendor-template.txt` *before* you paste it. Which lines would you question, and why?

&nbsp;

**Q2. Prediction.** After step 5, how many physical paths will exist between El Dorado and the rest of the network? Sketch them.

&nbsp;

**Q3. Prediction.** What do you think will happen when the first broadcast is sent?

&nbsp;

**Results during the cutover:**

| After step | ZFW-VOICE → 10.200.0.50 | Anything unusual? |
|---|---|---|
| 2 (fiber connected) | | |
| 4 (cross-connect A) | | |
| 5 (cross-connect B) | | |

**Q4.** Describe what the ARP envelopes did in Simulation mode. Did they ever stop?

&nbsp;

**Q5.** Event List count after 10 s: ______  20 s: ______  30 s: ______
Is this linear growth or faster? Why?

&nbsp;

**Q6.** Ethernet frames have no TTL (Time To Live) field. IP packets do. Why does this matter for loops at Layer 2 compared with Layer 3?

&nbsp;

**Q7.** Which sites received copies of the El Dorado broadcast? Was Amarillo affected even though nothing changed there today?

&nbsp;

---

## Part 3: Stop the Storm

**Time from trigger to containment:** ______ minutes. (FAA: 18 minutes from first symptoms to ground stop.)

**3.1** After containment, which services came back? Which did you lose? What would losing a radio site mean for controllers and pilots?

&nbsp;

**3.2** Diagnosis. Fill in the three conditions that lined up:

| Condition | Old, new, or today's decision? |
|---|---|
| 1. | |
| 2. | |
| 3. | |

**3.3** Why did you also harden **Amarillo**, which wasn't causing the problem?

&nbsp;

**3.4** After hardening, which of Fa0/23 and Fa0/24 on ELD-NEW is blocking? ______
Why that one? (Hint: compare port IDs and bridge IDs.)

&nbsp;

**3.5** (Challenge) What happened to the port the ROGUE switch was plugged into? Show the command output that proves it.

&nbsp;

**3.6 Reflect.** ELD-NEW did exactly what its configuration told it to do. **Who or what is responsible for this outage?** Use 2 or 3 sentences and consider the template author, the installer, the work order, and the network design.

&nbsp;

&nbsp;

---

## Part 4: Shrink the Blast Radius

**4.1** `tracert 172.16.20.10` from ZFW-VOICE shows ____ hops. Explain each hop.

&nbsp;

**4.2** During the re-break test, did the ARP storm pass ELD-RTR? Why or why not?

&nbsp;

**4.3** Fill in the comparison:

| | Original design (Part 2) | Routed design (Part 4) |
|---|---|---|
| Sites affected by the El Dorado mistake | | |
| Centers affected | | |
| Was El Dorado itself working? | | |

**4.4** Give one reason a network operator might *not* want to put a router at every remote site.

&nbsp;

---

## Part 5: Change Management

Attach your group's MOP. Then answer:

**5.1** Which rollback trigger in your MOP would have caught the storm earliest?

&nbsp;

**5.2** If you were the FAA, would you allow this kind of work on a Friday afternoon? Defend your answer.

&nbsp;
