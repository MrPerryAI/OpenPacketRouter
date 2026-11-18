"""The engine's storm math (engine/src/storm.js) must agree with the proof of concept.

Every storm-math scenario (the lab network in each state it visits) is turned into an engine spec, with
the same blocked ports, delays and link speeds, and run through engine/tools/storm.mjs. Regime, rho,
doubling time and the set of devices a loop reaches must match poc/storm-math exactly.
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

PY = scenarios()


def to_spec(topo):
    """A poc Topology as an engine spec plus per-link capacities (bits/s)."""
    ifaces = {d: {} for d in topo.devices}
    for l in topo.links:
        for dev, port in ((l.a, l.a_port), (l.b, l.b_port)):
            if topo.devices[dev] != "switch":
                ifaces[dev][port] = f"10.{l.id}.{len(ifaces[dev])}.1/24"
    nodes = []
    for name, kind in topo.devices.items():
        n = {"name": name, "kind": kind}
        if kind == "switch":
            n["blocked"] = sorted(p for d, p in topo.blocked if d == name)
        else:
            n["ifaces"] = ifaces[name]
        nodes.append(n)
    links = [[f"{l.a}:{l.a_port}", f"{l.b}:{l.b_port}", l.prop_delay * 1000] for l in topo.links]
    return {"spec": {"name": "storm parity", "nodes": nodes, "links": links},
            "capacities": [l.capacity for l in topo.links]}


def engine(topo, host=None):
    payload = to_spec(topo)
    if host: payload["host"] = host
    out = subprocess.run(["node", str(ROOT / "engine" / "tools" / "storm.mjs")], input=json.dumps(payload),
                         check=True, capture_output=True, text=True).stdout
    return json.loads(out)


@pytest.mark.parametrize("name", sorted(PY))
def test_engine_storm_matches_poc(name):
    topo = PY[name][1]
    p, js = predict(topo), engine(topo)
    assert js["regime"] == p.regime
    assert js["rho"] == pytest.approx(p.rho, abs=1e-6)
    if p.regime == "AMPLIFYING":
        assert js["doublingTime"] == pytest.approx(p.doubling_time, rel=1e-6)
    else:
        assert js["doublingTime"] is None
    assert js["devicesReached"] == sorted(p.devices_reached())
    label = lambda e: f"{e.tail}:{e.tail_port}>{e.head}:{e.head_port}"
    assert set(js["reachEdges"]) == {label(p.edges[i]) for i in p.reach_edges}
    assert set(js["loopEdges"]) == {label(p.edges[i]) for i in p.loop_edges}


@pytest.mark.parametrize("name,src", [("3b-xconA-core-blind", "ZFW-VOICE"), ("4a-xconAB-core-sees", "ZFW-VOICE"),
                                      ("6-routed-rebreak", "ELD-RADIO")])
def test_engine_steady_rates_match_poc(name, src):
    topo = PY[name][1]
    p = predict(topo)
    y = steady_rates(topo, p, src)
    label = lambda e: f"{e.tail}:{e.tail_port}>{e.head}:{e.head_port}"
    py = {label(e): y[i] for i, e in enumerate(p.edges) if y[i] > 0}
    js = engine(topo, src)["steady"]["rates"]
    assert set(js) == set(py)
    for k, v in py.items():
        assert js[k] == pytest.approx(v, rel=1e-6)


def test_engine_steady_rates_none_unless_circulating():
    assert engine(PY["1-baseline"][1], "ZFW-VOICE")["steady"] is None
    assert engine(PY["7-core-stp-off"][1], "ZFW-VOICE")["steady"] is None
