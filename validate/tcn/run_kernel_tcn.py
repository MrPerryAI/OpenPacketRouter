#!/usr/bin/env python3
"""Spanning-tree topology change notices vs real Linux kernel bridges, step for step.

    sudo python3 validate/tcn/run_kernel_tcn.py        (inside a privileged Linux container on a Mac)

Four STP bridges in a ring (ring.json, hello 1 s, max-age 6 s, forward delay 4 s, MAC aging 20 s) run the
steps in tcn.steps.json on the engine and on kernel bridges: wait, cut a cable, ping, and snapshots of
  * each bridge's topology_change flag, topology_change_detected (a TCN sent and not yet acknowledged)
    and the MAC aging time in force (the kernel cuts it to twice the forward delay while the flag is set),
  * each switch's learned MAC table (the kernel does not flush on a topology change; it ages faster, and its
    garbage collector only runs when the earliest entry would expire).
  * the kinds of BPDU each cable direction carried in a window (config, config+TC, config+TCA, config+TC+TCA, TCN),
    sniffed on every interface by validate/aging/cable.py; pings compare the frame counts per cable direction
    leaving out the spanning-tree frames, so flooding after the fast MAC aging is checked too.
    Windows that end in the middle of a reconvergence are not reported ("bpdus": "mark"): whether an acknowledgment
    carries the TC flag too depends on which hello slot the flag reaches the bridge in, and the kernel rounds its
    1 s hold timer to wall-clock seconds. The leaf-port flap at the end gives crisp sets.
Timing: the kernel arms its spanning-tree hold timer with round_jiffies(), so a pending BPDU (the TCN acknowledgment, the
TC flag passed down the tree) leaves on a whole wall-clock second. The kernel bridges therefore start half a second after a
second boundary and every step runs on the engine's schedule from there; the engine models the same rounding
(net.jiffyHolds = 0.5, engine/src/stp.js _holdTime). Events then sit half a second from the rounding threshold and from
every snapshot, which keeps the 10 s snapshot after the leaf-port flap exact (the TC flag reaches SW4 at 9.5 s).
Snapshots sit on plateaus, a few seconds from any transition, because BPDU timing differs by up to the
kernel's 1 s hold timer. It reuses the step runner of validate/aging.
"""
import os, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "aging"))
import run_kernel_aging as A  # noqa: E402

CASES = [("ring", "tcn.steps")]

if __name__ == "__main__":
    A.WATCH = []
    A.ALIGN = 0.5; os.environ["OPR_JIFFY_HOLDS"] = "0.5"   # kernel steps on the engine's schedule, half a second after wall-clock seconds (round_jiffies; see run_kernel_aging.py)
    if sys.argv[1:] == ["--inner"]: A.inner(HERE, CASES)
    else: sys.exit(A.main(HERE, CASES, __file__))
