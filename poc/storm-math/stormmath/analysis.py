"""Storm math: predict what one broadcast does, without simulating packets.

Flooding is a *non-backtracking walk*: a switch sends a frame out every
forwarding port except the one it came in on. Index frames by the directed
link they are on. One hop later, a frame on edge e becomes one frame on every
edge f that leaves e's head switch over a different link. That is the
non-backtracking matrix B:

    B[e, f] = 1  if head(e) == tail(f), link(f) != link(e), head(e) is a switch

If x_k counts frames on each edge after k hops, then x_{k+1} = B^T x_k.
The spectral radius rho = rho(B) classifies the network:

    rho == 0  -> TREE        every broadcast dies out after a few hops
    rho == 1  -> CIRCULATING frames loop forever but don't multiply; each new
                 broadcast adds more circulating frames (load ACCUMULATES)
    rho  > 1  -> AMPLIFYING  frames multiply by ~rho every hop (true storm)

With real hop delays d_e (time from a frame starting on edge e until the next
switch forwards it), the transmission rate on edge f obeys the renewal equation
    a_f(t) = sum_e B[e, f] a_e(t - d_e)
so frames grow like exp(r t) where r solves rho(B_r) = 1 with
B_r[e, f] = exp(-r d_e) * B[e, f], and the long-run share of transmissions on
each edge is the eigenvector u = B_r^T u.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .topology import DirectedEdge, Topology

TOL = 1e-6


def nb_matrix(topo: Topology, edges: list[DirectedEdge]) -> np.ndarray:
    n = len(edges)
    B = np.zeros((n, n))
    by_tail: dict[str, list[int]] = {}
    for j, f in enumerate(edges):
        by_tail.setdefault(f.tail, []).append(j)
    for i, e in enumerate(edges):
        if not topo.is_switch(e.head):
            continue
        for j in by_tail.get(e.head, []):
            if edges[j].link != e.link:
                B[i, j] = 1.0
    return B


def spectral_radius(M: np.ndarray) -> float:
    if M.size == 0:
        return 0.0
    return float(max(abs(np.linalg.eigvals(M))))


def _sccs(B: np.ndarray) -> list[list[int]]:
    """Tarjan's strongly connected components on the edge graph."""
    n = len(B)
    adj = [list(np.nonzero(B[i])[0]) for i in range(n)]
    index, low, on, stack, out = {}, {}, set(), [], []
    counter = [0]

    def visit(v):
        work = [(v, 0)]
        index[v] = low[v] = counter[0]; counter[0] += 1
        stack.append(v); on.add(v)
        while work:
            node, i = work[-1]
            if i < len(adj[node]):
                work[-1] = (node, i + 1)
                w = adj[node][i]
                if w not in index:
                    index[w] = low[w] = counter[0]; counter[0] += 1
                    stack.append(w); on.add(w)
                    work.append((w, 0))
                elif w in on:
                    low[node] = min(low[node], index[w])
            else:
                work.pop()
                if work:
                    parent = work[-1][0]
                    low[parent] = min(low[parent], low[node])
                if low[node] == index[node]:
                    comp = []
                    while True:
                        w = stack.pop(); on.discard(w); comp.append(w)
                        if w == node:
                            break
                    out.append(comp)

    for v in range(n):
        if v not in index:
            visit(v)
    return out


@dataclass
class Prediction:
    rho: float
    regime: str
    growth_rate: float  # 1/s, exponential rate of frame transmissions (0 unless amplifying)
    doubling_time: float | None
    loop_edges: list[int]  # edges that lie on a loop (recurrent)
    reach_edges: list[int]  # edges that carry loop traffic forever
    edges: list[DirectedEdge]
    B: np.ndarray
    delays: np.ndarray
    hotspot_share: dict[int, float] = field(default_factory=dict)  # amplifying only

    def devices_reached(self) -> set[str]:
        s = set()
        for i in self.reach_edges:
            s.add(self.edges[i].tail)
            s.add(self.edges[i].head)
        return s


def classify(rho: float) -> str:
    if rho < TOL:
        return "TREE"
    if abs(rho - 1) < TOL:
        return "CIRCULATING"
    return "AMPLIFYING" if rho > 1 else "DECAYING"


def growth_rate(B: np.ndarray, delays: np.ndarray) -> float:
    """Solve rho(diag(exp(-r d)) B) = 1 for r by bisection (rho decreases in r)."""
    if spectral_radius(B) <= 1 + TOL:
        return 0.0
    f = lambda r: spectral_radius(np.exp(-r * delays)[:, None] * B) - 1
    lo, hi = 0.0, 1.0
    while f(hi) > 0:
        hi *= 2
    for _ in range(200):
        mid = (lo + hi) / 2
        if f(mid) > 0:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def predict(topo: Topology) -> Prediction:
    edges = topo.directed_edges()
    B = nb_matrix(topo, edges)
    delays = np.array([topo.hop_delay(e) for e in edges])
    rho = spectral_radius(B)
    regime = classify(rho)

    loop = [i for comp in _sccs(B) for i in comp
            if len(comp) > 1 or B[comp[0], comp[0]] > 0]
    # everything downstream of a loop keeps receiving copies forever
    reach, frontier = set(loop), list(loop)
    while frontier:
        i = frontier.pop()
        for j in np.nonzero(B[i])[0]:
            if j not in reach:
                reach.add(int(j)); frontier.append(int(j))

    r = growth_rate(B, delays)
    p = Prediction(rho, regime, r, (np.log(2) / r) if r > 0 else None,
                   sorted(loop), sorted(reach), edges, B, delays)

    if regime == "AMPLIFYING":
        # Long-run share of transmissions per edge = Perron vector of B_r^T
        Br = np.exp(-r * delays)[:, None] * B
        vals, vecs = np.linalg.eig(Br.T)
        v = np.abs(np.real(vecs[:, np.argmax(np.real(vals))]))
        v = v / v.sum()
        p.hotspot_share = {i: float(v[i]) for i in range(len(edges)) if v[i] > 1e-9}
    return p


def hop_counts(B: np.ndarray, x0: np.ndarray, hops: int) -> np.ndarray:
    """Frames on each edge after each hop: rows are x_0 .. x_hops."""
    xs = [x0]
    for _ in range(hops):
        xs.append(B.T @ xs[-1])
    return np.array(xs)


def injection_vector(topo: Topology, edges: list[DirectedEdge], host: str) -> np.ndarray:
    """One broadcast sent by `host`: one frame on the host's outgoing edge(s)."""
    x0 = np.zeros(len(edges))
    for i, e in enumerate(edges):
        if e.tail == host:
            x0[i] = 1
    if not x0.any():
        raise ValueError(f"{host} has no forwarding link")
    return x0


def steady_rates(topo: Topology, p: Prediction, host: str) -> np.ndarray | None:
    """CIRCULATING networks only: after one broadcast from `host`, the
    long-run frames/second on every edge (before any link saturates).

    Each loop is a single directed cycle in edge-space, so the number of
    frames trapped on it is conserved. A trapped frame passes each cycle edge
    once per lap, i.e. at rate N / L (L = cycle latency). Copies leaking off the
    cycle flow downstream through the loop-free part of the network.
    """
    if p.regime != "CIRCULATING":
        return None
    B, edges = p.B, p.edges
    n = len(edges)
    x0 = injection_vector(topo, edges, host)
    # run long enough for every transient copy to land on a cycle or die
    xs = hop_counts(B, x0, 4 * n)
    trapped = xs[-1]
    rates = np.zeros(n)
    comps = [c for c in _sccs(B) if len(c) > 1 or B[c[0], c[0]] > 0]
    for comp in comps:
        N = trapped[comp].sum()  # conserved frames on this cycle
        L = p.delays[comp].sum()
        rates[comp] = N / L
    # downstream (non-cycle) edges: y = B^T y restricted, sources = cycle edges
    on_cycle = np.zeros(n, bool)
    for comp in comps:
        on_cycle[comp] = True
    y = rates.copy()
    for _ in range(4 * n):  # loop-free part is acyclic, so this converges exactly
        new = B.T @ y
        new[on_cycle] = rates[on_cycle]
        if np.allclose(new, y):
            break
        y = new
    return y
