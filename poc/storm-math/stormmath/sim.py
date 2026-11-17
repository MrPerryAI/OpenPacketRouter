"""Packet-by-packet event simulator - the independent check on the math.

It knows nothing about matrices. It just moves frames:
  - each link direction has one transmitter with a FIFO queue (drop-tail),
  - a frame takes frame_bits/capacity to serialize, then prop_delay to arrive,
  - the receiving switch takes switch_latency to look it up, then floods it
    out every forwarding port except the ingress one.
Every transmission is logged with its start time and edge.
"""
from __future__ import annotations

import heapq
from dataclasses import dataclass, field

import numpy as np

from .topology import Topology


@dataclass
class SimResult:
    tx_times: np.ndarray  # start time of every transmission
    tx_edges: np.ndarray  # edge index of every transmission
    drops: int
    deliveries: dict[str, int]  # host/router -> frames received
    events: int
    stopped_early: bool
    edges: list = field(default_factory=list)

    def rate_on(self, edge_idx: int, t0: float, t1: float) -> float:
        m = (self.tx_edges == edge_idx) & (self.tx_times >= t0) & (self.tx_times < t1)
        return m.sum() / (t1 - t0)

    def total_rate(self, t0: float, t1: float) -> float:
        m = (self.tx_times >= t0) & (self.tx_times < t1)
        return m.sum() / (t1 - t0)


def simulate(topo: Topology, injections: list[tuple[float, str]], t_end: float,
             queue_limit: int = 100, max_events: int = 3_000_000,
             unlimited: bool = False) -> SimResult:
    """unlimited=True: every frame transmits immediately (no queueing, no drops),
    so the only delays are the ones the math assumes. Used to check the math
    itself; the default (realistic) mode shows saturation."""
    edges = topo.directed_edges()
    out_of: dict[str, list[int]] = {}
    for j, e in enumerate(edges):
        out_of.setdefault(e.tail, []).append(j)
    ser = np.array([topo.frame_bits / topo.links[e.link].capacity for e in edges])
    prop = np.array([topo.links[e.link].prop_delay for e in edges])
    next_free = np.zeros(len(edges))

    tx_t, tx_e = [], []
    drops, events = 0, 0
    deliveries: dict[str, int] = {}
    heap: list[tuple[float, int, int]] = []  # (time, seq, edge arriving on)
    seq = 0

    def send(j: int, t: float):
        nonlocal drops, seq
        start = t if unlimited else max(t, next_free[j])
        if (start - t) / ser[j] > queue_limit:
            drops += 1
            return
        next_free[j] = start + ser[j]
        tx_t.append(start); tx_e.append(j)
        seq += 1
        heapq.heappush(heap, (start + ser[j] + prop[j], seq, j))

    for t, host in injections:
        for j in out_of.get(host, []):
            send(j, t)

    stopped = False
    while heap:
        t, _, j = heapq.heappop(heap)
        if t > t_end:
            break
        events += 1
        if events > max_events:
            stopped = True
            break
        e = edges[j]
        if not topo.is_switch(e.head):
            deliveries[e.head] = deliveries.get(e.head, 0) + 1
            continue
        t_fwd = t + topo.switch_latency
        for k in out_of.get(e.head, []):
            if edges[k].link != e.link:
                send(k, t_fwd)

    return SimResult(np.array(tx_t), np.array(tx_e, dtype=int), drops, deliveries,
                     events, stopped, edges)


def simulate_bundled(topo: Topology, injections: list[tuple[float, str]], t_end: float,
                     resolution: float = 1e-9) -> tuple[np.ndarray, np.ndarray, list]:
    """Unlimited-link simulation that can run for a long time.

    Same mechanics as simulate(unlimited=True), but frames that would arrive on
    the same edge at the same instant (to `resolution`) travel as one bundle
    with a count. Exponential frame counts become a polynomial number of events.
    Returns (times, counts, edge_index) for every transmission bundle.
    """
    edges = topo.directed_edges()
    out_of: dict[str, list[int]] = {}
    for j, e in enumerate(edges):
        out_of.setdefault(e.tail, []).append(j)
    ser = [topo.frame_bits / topo.links[e.link].capacity for e in edges]
    prop = [topo.links[e.link].prop_delay for e in edges]
    tick = lambda t: int(round(t / resolution))

    pending: dict[tuple[int, int], float] = {}  # (arrival tick, edge) -> frames
    heap: list[tuple[int, int]] = []
    log_t, log_n, log_e = [], [], []

    def send(j, t, n):
        log_t.append(t); log_n.append(n); log_e.append(j)
        key = (tick(t + ser[j] + prop[j]), j)
        if key not in pending:
            pending[key] = 0.0
            heapq.heappush(heap, key)
        pending[key] += n

    for t, host in injections:
        for j in out_of.get(host, []):
            send(j, t, 1.0)

    while heap:
        key = heapq.heappop(heap)
        n = pending.pop(key)
        t = key[0] * resolution
        if t > t_end:
            break
        e = edges[key[1]]
        if not topo.is_switch(e.head):
            continue
        for k in out_of.get(e.head, []):
            if edges[k].link != e.link:
                send(k, t + topo.switch_latency, n)
    return np.array(log_t), np.array(log_n), np.array(log_e, dtype=int)
