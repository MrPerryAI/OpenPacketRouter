#!/usr/bin/env python3
"""Proof of concept #2: storm math vs REAL Linux kernel bridges.

    sudo python3 run_kernel.py          # needs root, iproute2 and `unshare`

Each lab scenario is built in its own throwaway network namespace: switches are
Linux bridges (STP off), cables are emulated with fixed delays (see
stormmath/kernel.py). One ARP broadcast is injected and every transmission is
timed. The math gets the same cable delays plus the per-hop overhead measured
on a loop-free run, then we compare:
  TREE         exact number of copies, and every host hears it exactly once
  CIRCULATING  frames per second on every cable
  AMPLIFYING   exponential growth rate (frames double every ... ms)
Writes results/kernel-results.md and results/kernel-results.json.
"""
from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from stormmath.analysis import hop_counts, injection_vector, predict, steady_rates  # noqa: E402
from stormmath.scenarios import scenarios  # noqa: E402
from stormmath.sim import simulate_bundled  # noqa: E402
from stormmath.topology import Topology  # noqa: E402

MS = 1e-3
SRC = "ZFW-VOICE"
RUNS = {  # scenario -> (seconds to run, source host)
    "1-baseline": (0.6, SRC), "5-hardened": (0.6, SRC),
    "4a-xconAB-core-sees": (1.5, SRC), "6-routed-rebreak": (1.5, "ELD-RADIO"),
    "4b-xconAB-core-blind": (0.6, SRC), "7-core-stp-off": (1.0, SRC),
}


def cable_delays(topo: Topology) -> dict[int, float]:
    """Emulated delay per cable: the lab's long-haul delays, and 2 ms for local
    patches (Python can't time microsecond cables reliably)."""
    return {l.id: (l.prop_delay if l.prop_delay >= 1 * MS else 2 * MS) for l in topo.links}


def model_of(topo: Topology, delays: dict[int, float], overhead: float) -> Topology:
    t = topo.copy()
    t.links = [type(l)(l.id, l.a, l.a_port, l.b, l.b_port, delays[l.id], 1e15) for l in t.links]
    t.switch_latency = overhead
    return t


# ---------------------------------------------------------------- inner (inside the namespace)
def inner(name: str) -> None:
    from stormmath import kernel
    topo = scenarios()[name][1]
    seconds, src = RUNS[name]
    ports = kernel.build(topo)
    r = kernel.run(topo, ports, src, seconds, cable_delays(topo))
    json.dump({"tx": r.tx, "deliveries": r.deliveries, "drops": r.drops, "other": r.other_frames, "stopped": r.stopped,
               "first_drop": r.first_drop, "late": r.late}, sys.stdout)


def run_in_namespace(name: str) -> dict:
    out = subprocess.run(["unshare", "-n", "-m", sys.executable, str(Path(__file__).resolve()), "--inner", name],
                         check=True, capture_output=True, text=True, timeout=120)
    return json.loads(out.stdout)


# ---------------------------------------------------------------- outer
def first_arrivals(topo: Topology, delays, src):
    """For a loop-free topology: (sum of cable delays, switches crossed) before each edge transmits."""
    edges = topo.directed_edges()
    B = predict(topo).B
    D, H = {}, {}
    frontier = [i for i, e in enumerate(edges) if e.tail == src]
    for i in frontier:
        D[i], H[i] = 0.0, 0
    while frontier:
        nxt = []
        for i in frontier:
            for j in np.nonzero(B[i])[0]:
                j = int(j)
                if j not in D:
                    D[j] = D[i] + delays[edges[i].link]
                    H[j] = H[i] + 1
                    nxt.append(j)
        frontier = nxt
    return D, H


def main() -> int:
    if os.geteuid() != 0 or not shutil.which("unshare") or not shutil.which("ip"):
        print("Needs root, `unshare` and iproute2 (`ip`). Skipping.")
        return 0
    S = scenarios()
    raw = {name: run_in_namespace(name) for name in RUNS}
    rows, out = [], {}

    # 1) calibrate per-hop overhead (kernel bridge + relay) on the healthy network
    topo = S["1-baseline"][1]
    delays = cable_delays(topo)
    D, H = first_arrivals(topo, delays, SRC)
    seen = {}
    for t, i in raw["1-baseline"]["tx"]:
        seen.setdefault(i, t)
    pairs = [(seen[i] - D[i], H[i]) for i in seen if H[i] > 0]
    overhead = max(0.0, sum(x * h for x, h in pairs) / sum(h * h for _, h in pairs))
    out["overhead_ms_per_hop"] = overhead * 1e3

    for name, (seconds, src) in RUNS.items():
        desc, topo = S[name]
        delays = cable_delays(topo)
        model = model_of(topo, delays, overhead)
        p = predict(model)
        r = raw[name]
        tx = r["tx"]
        rec = {"regime": p.regime, "rho": p.rho, "kernel_frames": len(tx), "drops": r["drops"], "ignored_other_frames": r["other"]}
        if p.regime == "TREE":
            pred = int(hop_counts(p.B, injection_vector(model, p.edges, src), 4 * len(p.edges)).sum())
            hosts = sorted(d for d, k in model.devices.items() if k == "host" and d != src)
            once = all(r["deliveries"].get(h) == 1 for h in hosts)
            rec.update(predicted_copies=pred, ok=(len(tx) == pred and once))
            rows.append((name, p.regime, f"{pred} copies", f"{len(tx)} copies, each host once: {'yes' if once else 'NO'}", rec["ok"]))
        elif p.regime == "CIRCULATING":
            y = steady_rates(model, p, src)
            t0, t1 = seconds * .4, seconds * .95
            errs = []
            for i, e in enumerate(p.edges):
                if y[i] <= 0:
                    continue
                got = sum(1 for t, j in tx if j == i and t0 <= t < t1) / (t1 - t0)
                errs.append(abs(got - y[i]) / y[i])
            worst = max(errs)
            ex = int(np.argmax(y))
            got_ex = sum(1 for t, j in tx if j == ex and t0 <= t < t1) / (t1 - t0)
            rec.update(cables_compared=len(errs), worst_rel_error=worst, ok=worst < .10)
            rows.append((name, p.regime, f"{y[ex]:.0f} frames/s on busiest cable", f"{got_ex:.0f} frames/s; worst cable off by {worst:.1%} ({len(errs)} cables)", rec["ok"]))
        else:
            ts = np.array(sorted(t for t, _ in tx))
            n = np.arange(1, len(ts) + 1)
            # Growth is only free while no cable is full: fit from the 30th frame
            # until the first drop. Check the relay kept up in that window.
            t_end = r["first_drop"] if r["first_drop"] is not None else ts[-1]
            lo, hi = int(np.searchsorted(n, 30)), int(np.searchsorted(ts, t_end))
            fit = np.polyfit(ts[lo:hi], np.log(n[lo:hi]), 1)[0]
            late = [x for t, x in r["late"] if ts[lo] <= t <= t_end]
            # The same window in the independent packet simulator (same delays, no cable limit)
            T, N, _ = simulate_bundled(model, [(0.0, src)], t_end + .001)
            o = np.argsort(T); T, C = T[o], np.cumsum(N[o])
            m = (T >= ts[lo]) & (T <= t_end)
            sim_fit = np.polyfit(T[m], np.log(C[m]), 1)[0]
            dbl_p, dbl_k, dbl_s = (math.log(2) / x * 1e3 for x in (p.growth_rate, fit, sim_fit))
            err, err_s = abs(dbl_k - dbl_p) / dbl_p, abs(dbl_k - dbl_s) / dbl_s
            rec.update(window_ms=[ts[lo] * 1e3, t_end * 1e3], predicted_doubling_ms=dbl_p, simulator_window_doubling_ms=dbl_s,
                       kernel_doubling_ms=dbl_k, rel_error_vs_math=err, rel_error_vs_simulator=err_s,
                       relay_max_late_ms=max(late) * 1e3 if late else 0, ok=err < .25 and err_s < .15)
            rows.append((name, p.regime, f"doubles every {dbl_p:.1f} ms (long run); simulator {dbl_s:.1f} ms in the same window",
                         f"doubles every {dbl_k:.1f} ms in {ts[lo] * 1e3:.0f}–{t_end * 1e3:.0f} ms ({err:.0%} vs math, {err_s:.0%} vs simulator)", rec["ok"]))
        out[name] = rec

    (HERE / "results").mkdir(exist_ok=True)
    (HERE / "results" / "kernel-results.json").write_text(json.dumps(out, indent=2, default=lambda o: o.item()))
    md = ["| Scenario | Verdict | Math predicts | Linux kernel bridges did | Match |", "|---|---|---|---|---|"]
    md += [f"| {a} | {b} | {c} | {d} | {'✓' if ok else '✗'} |" for a, b, c, d, ok in rows]
    md.append(f"\nMeasured overhead per switch hop (kernel bridge + relay): {overhead * 1e3:.3f} ms, added to the model.")
    (HERE / "results" / "kernel-results.md").write_text("\n".join(md) + "\n")
    print("\n".join(md))
    return 0 if all(ok for *_, ok in rows) else 1


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--inner":
        inner(sys.argv[2])
    else:
        sys.exit(main())
