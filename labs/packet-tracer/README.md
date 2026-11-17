# One Router, 12,000 Flights: A Packet Tracer Lab on the FAA Ground Stop

On **Friday, November 13, 2026**, the FAA ordered a nationwide ground stop that lasted more than four hours. Operators canceled more than 12,000 flights that day. Investigators traced the problem to router replacement work on the FAA Telecommunications Infrastructure (FTI) network. At a remote radio site in El Dorado, Arkansas, a newly installed router began **flooding the network with traffic**, and air traffic control systems at 17 of the FAA's 22 en route centers became unstable.

In this lab, students build a simplified version of that network in Cisco Packet Tracer. They run a site cutover the way a rushed installer might, watch one remote site take down every center, and then fix and redesign the network so it can't happen again.

> **About accuracy.** As of November 17, 2026, the investigation is still open. The FAA hasn't said which protocol carried the flood or what made the device send it. This lab models the failure as a **Layer 2 broadcast storm**. A broadcast storm is a classic, well-understood way that one site's mistake floods a shared network, and Packet Tracer can show one clearly. Treat the lab as an **analogy that teaches the real lessons**, not a reconstruction of the exact fault. The [incident briefing](docs/incident-briefing.md) separates confirmed facts from open questions.

## What students learn

| Concept | Where |
|---|---|
| VLANs, 802.1Q trunks, shared broadcast domains | Part 1 |
| How a bridging loop turns into a broadcast storm | Part 2 |
| Why one remote site can affect the whole country ("failure domains") | Part 2 |
| Incident response: contain first, then find the cause | Part 3 |
| Spanning Tree (Rapid PVST+), root bridge placement, PortFast, BPDU Guard | Part 3 |
| Routers as broadcast boundaries; why you shrink Layer 2 domains | Part 4 |
| Change management: method of procedure (MOP), rollback plans, peer review | Part 5 |

Level: high school networking or intro CCNA (ITN/SRWE). Time: about 3 to 4 class periods of 45 minutes, and the parts can be used separately.

## Repo map

```
docs/
  incident-briefing.md     What happened, with sources (student-facing)
  topology.md              Diagram, cabling table, IP plan
labs/
  part1-build-baseline.md  Build the "FTI-lite" network and verify it
  part2-the-cutover.md     Do the El Dorado cutover and trigger the storm
  part3-stop-the-storm.md  Contain, diagnose, fix with STP/BPDU Guard
  part4-shrink-the-blast-radius.md   Add a routed boundary at the site
  part5-change-management.md         Write the MOP that should have existed
configs/
  1-baseline/   Paste-in CLI for every switch in the starting network
  2-cutover/    The "vendor template" for the new El Dorado device (the fault)
  3-fix/        Hardening configs
  4-redesign/   Router and switch changes for the routed design
ptbuilder/                 One-click build scripts for the three .pkt files
tools/make_ptbuilder.py    Regenerates ptbuilder/ from configs/
student/worksheet.md       Printable student worksheet
instructor/teacher-guide.md   Pacing, setup tips, answer key, discussion
pkt/                       Built .pkt files live here
```

## Quick start for the teacher

**Get the `.pkt` files in about 5 minutes with one-click builds.**

1. Install the free [PTBuilder](https://github.com/kimmknight/PTBuilder) extension in Packet Tracer 8.x. It's a one-time step.
2. Run the three scripts in [`ptbuilder/`](ptbuilder/README.md). Each one builds a complete lab state (devices, cables, configs, IPs) from an empty workspace.
3. Save them as `pkt/faa-ftl-baseline.pkt`, `pkt/faa-ftl-cutover.pkt`, and `pkt/faa-ftl-final.pkt`, then commit them. Students only ever need the `.pkt` files.
4. **Do a test run of Parts 2 and 3 before class.** Check that the storm appears and that the fix clears it.
5. Read [instructor/teacher-guide.md](instructor/teacher-guide.md) for pacing and the answer key.

**Prefer to build by hand, or want students to?** [Part 1](labs/part1-build-baseline.md) walks through a manual build with paste-in configs from `configs/`. It takes about 30 minutes and makes good practice.

> **Why build the `.pkt` in Packet Tracer instead of downloading one?** `.pkt` files are a Cisco format that only Packet Tracer can write. The scripts let Packet Tracer build the files itself, so they always open cleanly in your version. Once you commit them to `pkt/`, nobody has to build them again.

> **Privacy.** The answer key is in `instructor/`. Keep this repo private, or remove that folder before sharing with students.
