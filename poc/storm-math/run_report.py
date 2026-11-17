#!/usr/bin/env python3
"""Run every lab scenario through the math AND the simulator; write results/.

    python3 run_report.py
"""
from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

from stormmath.analysis import hop_counts, injection_vector, predict, steady_rates
from stormmath.scenarios import scenarios
from stormmath.sim import simulate, simulate_bundled

OUT = Path(__file__).parent / "results"
OUT.mkdir(exist_ok=True)

# chart tokens (validated palette, light mode)
SURFACE, INK, INK2, GRID = "#fcfcfb", "#0b0b0b", "#52514e", "#e4e3df"
BLUE, ORANGE = "#2a78d6", "#eb6834"
plt.rcParams.update({
    "figure.facecolor": SURFACE, "axes.facecolor": SURFACE, "savefig.facecolor": SURFACE,
    "axes.edgecolor": GRID, "axes.labelcolor": INK2, "xtick.color": INK2, "ytick.color": INK2,
    "text.color": INK, "font.size": 11, "axes.spines.top": False, "axes.spines.right": False,
    "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.8, "lines.linewidth": 2,
})

S = scenarios()
rows = []


def fmt(x, unit=""):
    return f"{x:,.0f}{unit}"


# ------------------------------------------------------------------ every scenario
for name, (desc, t) in S.items():
    p = predict(t)
    src = "ELD-RADIO" if name.startswith("6") else "ZFW-VOICE"
    row = {"name": name, "desc": desc, "rho": p.rho, "regime": p.regime,
           "reach": sorted(d for d in p.devices_reached() if d.endswith(("VOICE", "RADIO", "RADAR", "MON")))}
    if p.regime == "TREE":
        x0 = injection_vector(t, p.edges, src)
        pred = hop_counts(p.B, x0, 4 * len(p.edges)).sum()
        got = len(simulate(t, [(0, src)], 1.0).tx_times)
        row["check"] = f"copies of one broadcast: math {pred:.0f}, simulator {got}"
    elif p.regime == "CIRCULATING":
        y = steady_rates(t, p, src)
        r = simulate(t, [(0, src)], 0.6)
        hosts = [(i, e) for i, e in enumerate(p.edges)
                 if e.head.endswith(("VOICE", "RADIO", "RADAR", "MON")) and y[i] > 0]
        i, e = max(hosts, key=lambda h: y[h[0]])
        row["check"] = (f"broadcasts/s hitting {e.head} after ONE broadcast: "
                        f"math {fmt(y[i])}, simulator {fmt(r.rate_on(i, 0.3, 0.6))}")
    else:
        T, N, E = simulate_bundled(t, [(0, src)], 0.25 if name.startswith("4") else 0.6)
        o = np.argsort(T); T, N = T[o], N[o]
        C = np.cumsum(N)
        lo, hi = 0.6 * T[-1], T[-1]
        m = (T > lo) & (T < hi)
        r_sim = np.polyfit(T[m], np.log(C[m]), 1)[0]
        row["check"] = (f"frames double every: math {np.log(2)/p.growth_rate*1e3:.2f} ms, "
                        f"simulator {np.log(2)/r_sim*1e3:.2f} ms")
    rows.append(row)

# ------------------------------------------------------------------ figure 1: accumulation
t = S["4a-xconAB-core-sees"][1]
p = predict(t)
srcs = ["ZFW-VOICE", "ZAB-VOICE", "NOC-MON", "ZME-VOICE"]
inj = [(0.02 * k, srcs[k]) for k in range(4)]
r = simulate(t, inj, 0.1)
edge = next(i for i, e in enumerate(p.edges) if e.label().startswith("NOC-SW:Fa0/1 "))
per_bcast = steady_rates(t, p, "ZFW-VOICE")[edge]
cap = t.links[p.edges[edge].link].capacity / t.frame_bits
bins = np.arange(0, 0.1001, 0.001)
rate = np.histogram(r.tx_times[r.tx_edges == edge], bins)[0] / 0.001

fig, ax = plt.subplots(figsize=(8, 4.2))
ax.plot(bins[:-1] * 1e3, rate / 1e3, color=BLUE, label="Simulator")
for lvl, txt in [(per_bcast, f"Math: 1 broadcast = {per_bcast:,.0f}/s ({per_bcast/cap:.0%} of link)"),
                 (cap, f"Link full: {cap:,.0f}/s")]:
    ax.axhline(lvl / 1e3, color=INK2, linestyle="--", linewidth=1.5)
    ax.text(99, lvl / 1e3 + 4, txt, ha="right", va="bottom", color=INK2, fontsize=10)
for k, (ti, s) in enumerate(inj):
    ax.annotate(f"broadcast {k+1} sent", (ti * 1e3, 0), xytext=(ti * 1e3 + 0.5, 12),
                color=INK2, fontsize=9, rotation=90, va="bottom")
ax.set_xlim(0, 100); ax.set_ylim(0, 175)
ax.set_xlabel("Time (ms)"); ax.set_ylabel("Thousand frames / s")
ax.set_title("El Dorado loop, step 5 (core blocks the big loop): NOC → Fort Worth link",
             loc="left", fontsize=12, color=INK)
fig.tight_layout(); fig.savefig(OUT / "fig1-accumulating-storm.png", dpi=200); plt.close(fig)
fig1_drops = r.drops

# ------------------------------------------------------------------ figure 2: amplifying
t = S["4b-xconAB-core-blind"][1]
p = predict(t)
T, N, E = simulate_bundled(t, [(0, "ZFW-VOICE")], 0.06)
o = np.argsort(T); T, C = T[o], np.cumsum(N[o])
real = simulate(t, [(0, "ZFW-VOICE")], 0.06)
RT = np.sort(real.tx_times)
anchor_t, anchor_c = T[-1], C[-1]
line_t = np.linspace(0.02, 0.06, 50)
line_c = anchor_c * np.exp(p.growth_rate * (line_t - anchor_t))

fig, ax = plt.subplots(figsize=(8, 4.2))
ax.semilogy(T * 1e3, C, color=BLUE, label="Simulator, links never fill")
ax.semilogy(RT * 1e3, np.arange(1, len(RT) + 1), color=ORANGE, label="Simulator, real link speeds")
ax.semilogy(line_t * 1e3, line_c, color=INK2, linestyle="--", linewidth=1.5,
            label=f"Math: doubles every {p.doubling_time*1e3:.2f} ms")
yb = np.interp(0.052, T, C)
ax.text(51, yb * 6, "links never fill", color=BLUE, ha="right", fontsize=10)
ax.text(59, len(RT) * 3, "real link speeds: capped by capacity", color=ORANGE, ha="right", fontsize=10)
ax.set_xlim(0, 60)
ax.set_xlabel("Time (ms)"); ax.set_ylabel("Total frames sent (log scale)")
ax.set_title("El Dorado loop, step 5 (core can't see the loop): one broadcast",
             loc="left", fontsize=12, color=INK)
ax.legend(frameon=False, loc="upper left", fontsize=9)
fig.tight_layout(); fig.savefig(OUT / "fig2-amplifying-storm.png", dpi=200); plt.close(fig)

# ------------------------------------------------------------------ results table
lines = ["| Scenario | ρ | Verdict | Hosts flooded | Math vs simulator |", "|---|---|---|---|---|"]
for row in rows:
    reach = ", ".join(row["reach"]) if row["reach"] else "none"
    lines.append(f"| **{row['name']}** — {row['desc']} | {row['rho']:.3f} | {row['regime']} "
                 f"| {reach} | {row['check']} |")
(OUT / "results-table.md").write_text("\n".join(lines) + "\n")
print("\n".join(lines))
print(f"\nfig1: per-broadcast {per_bcast:,.0f}/s, capacity {cap:,.0f}/s, drops {fig1_drops}")
print(f"fig2: real-speed total after 60 ms: {len(RT):,} frames, drops {real.drops}")
