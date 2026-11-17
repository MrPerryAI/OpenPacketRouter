# Part 4: Shrink the Blast Radius

**Goal:** Redesign El Dorado so that *even if the same mistake happens again*, it can't reach the rest of the country.
**Time:** About 45 minutes.
**Start from:** your fixed network at the end of Part 3. Save a copy first as `faa-ftl-fixed.pkt`.

## The idea

In Part 3 you fixed the **configuration**. But someone will make a configuration mistake again someday. A better question is: **when it happens, how many Centers will it hurt?**

The problem with FTI-lite is that VLAN 200 stretches from Albuquerque to El Dorado, so one broadcast domain covers the whole country. Engineers call this a large **failure domain** or **blast radius**.

**Routers do not forward broadcasts.** If you put a router at the edge of El Dorado, a storm inside the site stays inside the site.

```
BEFORE:  [Centers]==VLAN 200==[ZME-SW]==VLAN 200==[ELD switches]   one huge broadcast domain
AFTER:   [Centers]==VLAN 200==[ZME-SW]--[ELD-RTR]--[ELD switches]  storm stops at the router
                                        10.200.0.20 | 172.16.20.1
```

## Steps

### 1. Re-cable
- **Delete** cabling row 6 (ZME-SW Fa0/4 ↔ ELD-OLD Fa0/1).
- **Delete** cabling row 14 (NOC-SW Gi0/1 ↔ ELD-NEW Gi0/1).
- Add a **2911** router named `ELD-RTR`.
- Row 17: ZME-SW **Fa0/4** ↔ ELD-RTR **Gi0/0** (straight-through).
- Row 18: ELD-RTR **Gi0/1** ↔ ELD-NEW **Gi0/1** (straight-through).
- Keep both cross-connects (rows 15 and 16) between ELD-NEW and ELD-OLD.

### 2. Configure
| Device | File |
|---|---|
| ELD-RTR | [`configs/4-redesign/ELD-RTR.txt`](../configs/4-redesign/ELD-RTR.txt) (answer `no` to the setup dialog first) |
| ZME-SW, NOC-SW, ELD-NEW, ELD-OLD | the matching sections of [`configs/4-redesign/switch-changes.txt`](../configs/4-redesign/switch-changes.txt) |

Re-address **ELD-RADIO**: IP `172.16.20.10`, mask `255.255.255.0`, gateway `172.16.20.1`.

### 3. Verify the new design
| From | Command | Expected |
|---|---|---|
| ZFW-VOICE | `ping 10.200.0.20` | Success (router's FTI side) |
| ZFW-VOICE | `ping 172.16.20.10` | Success (routed to the radio) |
| ZFW-VOICE | `tracert 172.16.20.10` | 2 hops. Why 2? |
| ZAB-RADAR | `ping 10.100.0.60` | Success |

### 4. Prove it: break El Dorado on purpose
Save first. Then paste [`configs/4-redesign/REBREAK-TEST.txt`](../configs/4-redesign/REBREAK-TEST.txt) on **both** ELD-NEW and ELD-OLD. That puts the original mistake back.

Now trigger a storm **inside** El Dorado. On **ELD-RADIO**, in Simulation mode with the ARP filter on:

```
ELD-RADIO> arp -d
ELD-RADIO> ping 172.16.20.99
```

(`.99` doesn't exist, so the ARP broadcast is never answered and just keeps circulating.)

Watch carefully and answer on the worksheet:
- Do the ARP frames reach ELD-RTR? Do they go **past** it?
- Switch to Realtime. From **ZFW-VOICE**, `ping 10.200.0.12` (ZME-VOICE). Are the Centers affected?
- From **ZFW-VOICE**, `ping 172.16.20.10`. Is El Dorado itself OK?

**The takeaway:** the mistake still happened, and El Dorado still had a bad day. But it was **one site's bad day**, not 12,000 canceled flights.

### 5. Clean up
Re-apply `configs/3-fix/3-HARDEN-ELD-NEW.txt` and `3-HARDEN-ELD-OLD.txt`, then save as `faa-ftl-final.pkt`. **Defense in depth** means good configs *and* small failure domains.

## Discussion: why not route everything?

If routers contain storms so well, why did the FTI-lite design stretch VLANs across the country in the first place? Discuss with your group:
- Some older systems were built to expect their devices to be on the same Layer 2 network.
- Routed designs need more IP planning and more devices, and they cost more to configure and maintain.
- The FAA's network is decades old. Officials have described parts of it as antiquated, and Secretary Duffy has asked Congress for $50 billion to modernize air traffic control.
