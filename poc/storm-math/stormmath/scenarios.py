"""The FAA ground stop Packet Tracer lab network, in every state the lab visits.

Link delays and speeds are ILLUSTRATIVE assumptions, not FAA data:
long-haul FTI links get a few milliseconds, local patch cables ~1 microsecond.
Every link is FastEthernet except the new El Dorado fiber (Gigabit).
Only one VLAN's broadcast domain is modeled (the VOICE VLAN).

Where spanning tree would block a port, we have to say which one. Real STP
picks by bridge ID (MAC address), which the lab doesn't fix, so each choice is
marked ASSUMED. Any choice that breaks the same loop gives the same verdict.
"""
from __future__ import annotations

from .topology import GIGABIT, HOST, ROUTER, SWITCH, Topology

MS = 1e-3
US = 1e-6

CENTERS = ["ZFW", "ZME", "ZAB"]


def base() -> Topology:
    t = Topology()
    for s in ["NOC-SW", "ZFW-SW", "ZME-SW", "ZAB-SW", "ELD-OLD", "AMA-SW"]:
        t.add(s, SWITCH)
    for h in ["NOC-MON", "ZFW-VOICE", "ZME-VOICE", "ZAB-VOICE", "ELD-RADIO", "AMA-RADAR"]:
        t.add(h, HOST)
    t.connect("NOC-SW", "Fa0/1", "ZFW-SW", "Fa0/1", 4 * MS)
    t.connect("NOC-SW", "Fa0/2", "ZME-SW", "Fa0/1", 6 * MS)
    t.connect("NOC-SW", "Fa0/3", "ZAB-SW", "Fa0/1", 8 * MS)
    t.connect("ZFW-SW", "Fa0/2", "ZME-SW", "Fa0/2", 5 * MS)  # backup
    t.connect("ZME-SW", "Fa0/3", "ZAB-SW", "Fa0/2", 9 * MS)  # backup
    t.connect("ZME-SW", "Fa0/4", "ELD-OLD", "Fa0/1", 3 * MS)  # legacy copper
    t.connect("ZAB-SW", "Fa0/4", "AMA-SW", "Fa0/1", 3 * MS)
    t.connect("NOC-SW", "Fa0/10", "NOC-MON", "Fa0", 1 * US)
    for c in CENTERS:
        t.connect(f"{c}-SW", "Fa0/11", f"{c}-VOICE", "Fa0", 1 * US)
    t.connect("ELD-OLD", "Fa0/10", "ELD-RADIO", "Fa0", 1 * US)
    t.connect("AMA-SW", "Fa0/10", "AMA-RADAR", "Fa0", 1 * US)
    # converged STP on the core ring: one end of each backup link blocks (ASSUMED: ZME side)
    t.block("ZME-SW", "Fa0/2").block("ZME-SW", "Fa0/3")
    return t


def with_eld_new(t: Topology, xconnects: int) -> Topology:
    t = t.copy()
    t.add("ELD-NEW", SWITCH)
    t.connect("NOC-SW", "Gi0/1", "ELD-NEW", "Gi0/1", 7 * MS, GIGABIT)  # new fiber
    if xconnects >= 1:
        t.connect("ELD-NEW", "Fa0/23", "ELD-OLD", "Fa0/23", 1 * US)
    if xconnects >= 2:
        t.connect("ELD-NEW", "Fa0/24", "ELD-OLD", "Fa0/24", 1 * US)
    return t


def scenarios() -> dict[str, tuple[str, Topology]]:
    s: dict[str, tuple[str, Topology]] = {}

    s["1-baseline"] = ("Part 1: healthy network, STP converged", base())

    s["2-fiber"] = ("Part 2 step 2: new fiber connected, no cross-connects",
                    with_eld_new(base(), 0))

    t = with_eld_new(base(), 1).block("ZME-SW", "Fa0/4")
    s["3a-xconA-core-sees"] = ("Step 4, cross-connect A; core STP sees the big loop "
                               "(real Cisco: BPDUs pass through) - ZME Fa0/4 blocks (ASSUMED)", t)

    s["3b-xconA-core-blind"] = ("Step 4, cross-connect A; core STP can't see the loop "
                                "(BPDUs dropped at El Dorado)", with_eld_new(base(), 1))

    t = with_eld_new(base(), 2).block("ZME-SW", "Fa0/4")
    s["4a-xconAB-core-sees"] = ("Step 5, both cross-connects; core blocks the big loop, "
                                "the El Dorado pair loops on its own", t)

    s["4b-xconAB-core-blind"] = ("Step 5, both cross-connects; core can't see either loop",
                                 with_eld_new(base(), 2))

    t = with_eld_new(base(), 2).block("ZME-SW", "Fa0/4").block("ELD-OLD", "Fa0/24")
    s["5-hardened"] = ("Part 3: STP back on at El Dorado - one cross-connect and one "
                       "uplink block (ASSUMED ELD-OLD Fa0/24, ZME Fa0/4)", t)

    t = with_eld_new(base(), 2)
    t = t.without_link("ZME-SW", "Fa0/4").without_link("NOC-SW", "Gi0/1")
    t.add("ELD-RTR", ROUTER)
    t.connect("ZME-SW", "Fa0/4", "ELD-RTR", "Gi0/0", 3 * MS)
    t.connect("ELD-RTR", "Gi0/1", "ELD-NEW", "Gi0/1", 1 * US)
    s["6-routed-rebreak"] = ("Part 4: routed edge, then the original mistake re-made "
                             "inside El Dorado", t)

    t = base()
    t.blocked.clear()
    s["7-core-stp-off"] = ("What-if: spanning tree off on the core ring itself", t)
    return s
