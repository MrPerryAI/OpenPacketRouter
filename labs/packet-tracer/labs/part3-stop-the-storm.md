# Part 3: Stop the Storm

**Goal:** Respond like a NOC. **Contain** first, **diagnose** second, **fix** third, and **restore** last, carefully.
**Time:** About 45 minutes.
**Start from:** `faa-ftl-cutover.pkt` with the storm running, or trigger it again with step 6 of Part 2.

## The clock is running

On November 13, controllers noticed problems at **3:36 p.m.**, and the FAA stopped all departures at **3:54 p.m.**, 18 minutes later. The ground stop lasted until **8:15 p.m.** Your teacher may time this part.

## Step 1: Contain (stop the bleeding)

You don't know the root cause yet, but you know something changed at El Dorado today. The quickest safe move is to **cut El Dorado off from the core**. That's what the real operator did when it blocked traffic from the Arkansas and Texas sites.

Paste the commands from [`configs/3-fix/1-CONTAINMENT.txt`](../configs/3-fix/1-CONTAINMENT.txt) on **NOC-SW** and **ZME-SW**.

In Simulation mode, press **Reset Simulation**. Then, from **ZAB-RADAR**, run `arp -d` and `ping 10.100.0.60`.

- Did the Centers recover? 
- What did you **give up** to get them back? (Try `ZFW-VOICE → ping 10.200.0.50`.) In the real world, what would losing a radio site mean for controllers?

## Step 2: Diagnose

The Centers are stable, so now find out *why*. Run these on the El Dorado devices:

```
ELD-NEW# show spanning-tree
ELD-NEW# show running-config | include spanning
ELD-NEW# show interfaces trunk
ELD-OLD# show spanning-tree
ELD-OLD# show running-config | include spanning
```

Answer on the worksheet:
1. Physically, how many paths connect ELD-NEW and ELD-OLD now? How many paths connect El Dorado to the core?
2. What's supposed to stop loops on a switched network? Why didn't it?
3. Name the **three conditions** that had to line up for this storm to happen. (Hint: one is old, one is new, and one is a human decision made today.)

## Step 3: Fix (harden every site that uses the template)

Paste these files:

| Device | File |
|---|---|
| ELD-NEW | [`3-HARDEN-ELD-NEW.txt`](../configs/3-fix/3-HARDEN-ELD-NEW.txt) |
| ELD-OLD | [`3-HARDEN-ELD-OLD.txt`](../configs/3-fix/3-HARDEN-ELD-OLD.txt) |
| AMA-SW | [`3-HARDEN-AMA-SW.txt`](../configs/3-fix/3-HARDEN-AMA-SW.txt) |

Why fix **Amarillo** when it isn't the problem? After Nov 13, the FAA disabled the "broadcast function" on all of the newly installed routers, not just the one in El Dorado. When one device fails because of a **template**, every device built from that template is suspect.

Verify on ELD-NEW:

```
ELD-NEW# show spanning-tree vlan 200
```

Exactly **one** of Fa0/23 or Fa0/24 should be **BLK** (blocking). Spanning tree is now cancelling out the "spare" cable.

## Step 4: Restore (lifting the ground stop)

Bring El Dorado back **one path at a time**, testing in between, using [`configs/3-fix/4-RESTORE.txt`](../configs/3-fix/4-RESTORE.txt).

After each `no shutdown`:
1. Fast-forward time until the lights are green.
2. Run `show spanning-tree vlan 200` on ZME-SW and ELD-NEW. Which ports block?
3. `arp -d` then `ping 10.200.0.50` from ZFW-VOICE. In Simulation mode, does the ARP broadcast die out?

## Step 5: Prove BPDU Guard works (challenge)

1. Drag a new 2960 switch into El Dorado and call it `ROGUE`.
2. Cable `ROGUE` Fa0/1 to **ELD-OLD Fa0/5**, a host port with BPDU Guard on.
3. Watch the link light and run `show interfaces status` on ELD-OLD.
4. What state is Fa0/5 in? How do you recover it? (Hint: `shutdown` then `no shutdown` on the port, after removing the rogue switch.)

## Reflect

The real FAA routers were "working as configured." In your network, ELD-NEW did exactly what its template told it to do. Write two or three sentences on the worksheet: **Who or what is responsible for this outage?**
