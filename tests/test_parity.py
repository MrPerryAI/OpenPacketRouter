"""The Storm Lab's JavaScript engine must agree with the Python proof of concept.

Runs tools/engine_scenarios.mjs (the lab's own engine, in Node) and compares every
lab scenario against poc/storm-math. Spanning tree is computed in JS but given as
input in Python, so blocked-port choices may differ; the verdicts must not.
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "poc" / "storm-math"))
from stormmath.analysis import predict, steady_rates  # noqa: E402
from stormmath.scenarios import scenarios  # noqa: E402

JS = json.loads(subprocess.run(["node", str(ROOT / "tools" / "engine_scenarios.mjs")],
                               check=True, capture_output=True, text=True).stdout)
PY = scenarios()


@pytest.mark.parametrize("name", sorted(PY))
def test_same_verdict_and_numbers(name):
    js, (_, topo) = JS[name], PY[name]
    p = predict(topo)
    assert js["regime"] == p.regime
    assert js["rho"] == pytest.approx(p.rho, abs=1e-6)
    if p.regime == "AMPLIFYING":
        assert js["doubling_ms"] == pytest.approx(p.doubling_time * 1000, rel=1e-3)
    hosts = sorted(d for d in p.devices_reached() if topo.devices[d] == "host")
    assert js["reach_hosts"] == hosts


@pytest.mark.parametrize("name,src", [("4a-xconAB-core-sees", "ZFW-VOICE"), ("6-routed-rebreak", "ELD-RADIO")])
def test_same_per_host_storm_rates(name, src):
    topo = PY[name][1]
    p = predict(topo)
    y = steady_rates(topo, p, src)
    py_rates = {e.head: y[i] for i, e in enumerate(p.edges) if topo.devices[e.head] == "host" and y[i] > 0}
    assert set(JS[name]["host_rates"]) == set(py_rates)
    for h, v in py_rates.items():
        assert JS[name]["host_rates"][h] == pytest.approx(v, rel=1e-6)
