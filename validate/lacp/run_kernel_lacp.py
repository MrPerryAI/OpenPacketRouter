#!/usr/bin/env python3
"""LACP link aggregation vs real Linux bonds (mode 802.3ad), cable by cable.

    sudo python3 validate/lacp/run_kernel_lacp.py        (inside a privileged Linux container on a Mac)

Two switches joined by three cables bundled into a port-channel (lacp.json: a kernel bond enslaved to each bridge). The
steps in lacp.steps.json run on the engine and on the kernel: waits, pings, a cable cut and restored, and snapshots of
  * every member's carrier, LACP actor state byte and partner state byte (the bonding driver's ad_actor_oper_port_state
    and ad_partner_oper_port_state: sync, collecting, distributing, and the short/long timeout bit each side asked for),
  * which kinds of LACPDU each cable direction carried in a window (sniffed on every interface; the kernel's own timers
    drift by hundreds of milliseconds under load, so windows sit on plateaus and the sets of PDU kinds are compared, not times),
  * the number of data frames on every cable direction per ping, so which member the transmit hash picked (kernel
    xmit_hash_policy layer2, with the engine's MAC addresses on the kernel interfaces) is checked frame for frame,
    including flooding of broadcasts through the channel and the failover after a cable cut.
It reuses the step runner of validate/aging.
"""
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "aging"))
import run_kernel_aging as A  # noqa: E402

CASES = [("lacp", "lacp.steps")]

if __name__ == "__main__":
    A.WATCH = []
    if sys.argv[1:] == ["--inner"]: A.inner(HERE, CASES)
    else: sys.exit(A.main(HERE, CASES, __file__))
