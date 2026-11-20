"""The RIP validator's 'newly poisoned' rule must not depend on whether the last update before a snapshot was triggered or periodic."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "validate" / "rip"))
import run_kernel_rip as rr  # noqa: E402

C, S = "R2:eth0>R1:eth1", "10.0.12.2"


def resp(t, entries):
    return {"t": t, "cable": C, "src": S, "dst": "224.0.0.9", "ttl": 1, "command": "response", "version": 2,
            "entries": [{"net": n, "mask": "255.255.255.0", "nextHop": "0.0.0.0", "metric": m, "tag": 0} for n, m in entries]}


PERIODIC = resp(10, [("10.0.12.0", 16), ("10.1.0.0", 16), ("10.3.0.0", 2)])   # poisoned reverse of R1's networks
TRIGGERED = resp(14, [("10.3.0.0", 16)])                                       # only the changed route
NEXT_PERIODIC = resp(20, [("10.0.12.0", 16), ("10.1.0.0", 16), ("10.3.0.0", 16)])


def test_poisoned_reverse_is_not_new_after_a_triggered_update():
    before = [PERIODIC, TRIGGERED]
    _, poisoned, _, _ = rr.views([NEXT_PERIODIC], before + [NEXT_PERIODIC], before)
    assert poisoned == {}


def test_a_route_poisoned_for_the_first_time_is_new():
    before = [PERIODIC]
    _, poisoned, _, _ = rr.views([TRIGGERED], before + [TRIGGERED], before)
    assert poisoned == {C: ["10.3.0.0/255.255.255.0"]}
