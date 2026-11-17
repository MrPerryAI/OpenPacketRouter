import math

import numpy as np
import pytest

from stormmath.analysis import hop_counts, injection_vector, predict, steady_rates
from stormmath.scenarios import scenarios
from stormmath.sim import simulate, simulate_bundled
from stormmath.topology import HOST, SWITCH, Topology

S = scenarios()


def switches(*names, host=True):
    t = Topology()
    for n in names:
        t.add(n, SWITCH)
    if host:
        t.add("H", HOST)
        t.connect("H", "eth0", names[0], "h", 1e-6)
    return t


# ---------------------------------------------------------------- pure math
def test_line_is_tree():
    t = switches("A", "B", "C")
    t.connect("A", "1", "B", "1").connect("B", "2", "C", "1")
    assert predict(t).regime == "TREE"


def test_triangle_circulates():
    t = switches("A", "B", "C")
    t.connect("A", "1", "B", "1").connect("B", "2", "C", "1").connect("C", "2", "A", "2")
    p = predict(t)
    assert p.regime == "CIRCULATING" and p.rho == pytest.approx(1)


def test_parallel_pair_circulates():
    t = switches("A", "B")
    t.connect("A", "1", "B", "1").connect("A", "2", "B", "2")
    assert predict(t).regime == "CIRCULATING"


def test_blocked_port_breaks_loop():
    t = switches("A", "B")
    t.connect("A", "1", "B", "1").connect("A", "2", "B", "2").block("B", "2")
    assert predict(t).regime == "TREE"


def test_full_mesh_of_four_amplifies_by_two():
    # every switch has 3 neighbours: a flooded frame leaves on 2 of them
    t = switches("A", "B", "C", "D", host=False)
    names = ["A", "B", "C", "D"]
    for i in range(4):
        for j in range(i + 1, 4):
            t.connect(names[i], f"to{names[j]}", names[j], f"to{names[i]}")
    assert predict(t).rho == pytest.approx(2)


def test_uniform_delay_growth_is_log_rho_over_delay():
    t = switches("A", "B", "C", "D", host=False)
    names = ["A", "B", "C", "D"]
    for i in range(4):
        for j in range(i + 1, 4):
            t.connect(names[i], f"to{names[j]}", names[j], f"to{names[i]}", 1e-3)
    p = predict(t)
    d = p.delays[0]
    assert p.growth_rate == pytest.approx(math.log(2) / d, rel=1e-6)


# ---------------------------------------------------------------- math vs simulator
@pytest.mark.parametrize("name", ["1-baseline", "2-fiber", "3a-xconA-core-sees", "5-hardened"])
def test_tree_copy_count_matches_simulator(name):
    t = S[name][1]
    p = predict(t)
    assert p.regime == "TREE"
    x0 = injection_vector(t, p.edges, "ZFW-VOICE")
    predicted = hop_counts(p.B, x0, 4 * len(p.edges)).sum()
    assert predicted == len(simulate(t, [(0, "ZFW-VOICE")], 1.0).tx_times)


@pytest.mark.parametrize("name,src", [("4a-xconAB-core-sees", "ZFW-VOICE"),
                                      ("6-routed-rebreak", "ELD-RADIO")])
def test_circulating_rates_match_simulator(name, src):
    t = S[name][1]
    p = predict(t)
    y = steady_rates(t, p, src)
    r = simulate(t, [(0, src)], 0.3)
    assert r.drops == 0
    for i in np.nonzero(y)[0]:
        if y[i] > 1000:  # fast loops: enough samples for a tight check
            assert r.rate_on(i, 0.15, 0.3) == pytest.approx(y[i], rel=0.005)


def test_amplifying_growth_and_hotspots_match_simulator():
    t = S["7-core-stp-off"][1]
    p = predict(t)
    T, N, E = simulate_bundled(t, [(0, "ZFW-VOICE")], 0.6)
    o = np.argsort(T)
    T, N, E = T[o], N[o], E[o]
    C = np.cumsum(N)
    m = (T > 0.4) & (T < 0.6)
    assert np.polyfit(T[m], np.log(C[m]), 1)[0] == pytest.approx(p.growth_rate, rel=0.01)
    w = np.bincount(E[m], weights=N[m], minlength=len(p.edges))
    share = w / w.sum()
    for i in range(len(p.edges)):
        assert share[i] == pytest.approx(p.hotspot_share.get(i, 0), abs=0.005)


def test_bundled_simulator_matches_frame_simulator():
    t = S["7-core-stp-off"][1]
    r = simulate(t, [(0, "ZFW-VOICE")], 0.05, unlimited=True)
    T, N, _ = simulate_bundled(t, [(0, "ZFW-VOICE")], 0.05)
    assert N[T < 0.04].sum() == (r.tx_times < 0.04).sum()


# ---------------------------------------------------------------- lab claims
def test_router_contains_the_storm():
    p = predict(S["6-routed-rebreak"][1])
    assert p.regime == "CIRCULATING"
    assert p.devices_reached() == {"ELD-NEW", "ELD-OLD", "ELD-RADIO", "ELD-RTR"}


def test_hardening_removes_every_loop():
    assert predict(S["5-hardened"][1]).regime == "TREE"
