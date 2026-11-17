"""Network description: devices, links, and which ports are forwarding.

Only what matters for flooding is modeled:
  - SWITCH: floods a broadcast out every forwarding port except the one it
    arrived on.
  - HOST / ROUTER: receive broadcasts but never forward them.
A link carries frames in a direction only if the ports at BOTH ends are
forwarding (a blocked STP port neither sends nor accepts data frames).
"""
from __future__ import annotations

from dataclasses import dataclass, field

SWITCH, HOST, ROUTER = "switch", "host", "router"

FAST_ETHERNET = 100e6
GIGABIT = 1e9


@dataclass(frozen=True)
class Link:
    id: int
    a: str
    a_port: str
    b: str
    b_port: str
    prop_delay: float  # seconds, one way
    capacity: float  # bits per second


@dataclass(frozen=True)
class DirectedEdge:
    """One direction of one link: frames leave `tail` and arrive at `head`."""
    link: int
    tail: str
    tail_port: str
    head: str
    head_port: str

    def label(self) -> str:
        return f"{self.tail}:{self.tail_port} -> {self.head}:{self.head_port}"


@dataclass
class Topology:
    devices: dict[str, str] = field(default_factory=dict)  # name -> kind
    links: list[Link] = field(default_factory=list)
    blocked: set[tuple[str, str]] = field(default_factory=set)  # (device, port)
    switch_latency: float = 5e-6  # store-and-forward lookup time per hop
    frame_bits: int = 84 * 8  # 64-byte frame + preamble + inter-frame gap

    # ---- building
    def add(self, name: str, kind: str) -> "Topology":
        self.devices[name] = kind
        return self

    def connect(self, a, a_port, b, b_port, prop_delay=1e-6, capacity=FAST_ETHERNET):
        for d in (a, b):
            if d not in self.devices:
                raise KeyError(f"unknown device {d}")
        self.links.append(Link(len(self.links), a, a_port, b, b_port, prop_delay, capacity))
        return self

    def block(self, device: str, port: str) -> "Topology":
        self.blocked.add((device, port))
        return self

    def copy(self) -> "Topology":
        t = Topology(dict(self.devices), list(self.links), set(self.blocked),
                     self.switch_latency, self.frame_bits)
        return t

    def without_link(self, a: str, a_port: str) -> "Topology":
        t = self.copy()
        t.links = [l for l in t.links if not ((l.a, l.a_port) == (a, a_port) or (l.b, l.b_port) == (a, a_port))]
        t.links = [Link(i, l.a, l.a_port, l.b, l.b_port, l.prop_delay, l.capacity) for i, l in enumerate(t.links)]
        return t

    # ---- derived views
    def forwarding(self, device: str, port: str) -> bool:
        return (device, port) not in self.blocked

    def directed_edges(self) -> list[DirectedEdge]:
        """Every link direction that can carry a data frame."""
        out = []
        for l in self.links:
            if not (self.forwarding(l.a, l.a_port) and self.forwarding(l.b, l.b_port)):
                continue
            out.append(DirectedEdge(l.id, l.a, l.a_port, l.b, l.b_port))
            out.append(DirectedEdge(l.id, l.b, l.b_port, l.a, l.a_port))
        return out

    def hop_delay(self, edge: DirectedEdge) -> float:
        """Time from a frame starting to leave `tail` until `head` can forward it
        (no queueing): serialization + propagation + the head's lookup time."""
        l = self.links[edge.link]
        return self.frame_bits / l.capacity + l.prop_delay + self.switch_latency

    def is_switch(self, name: str) -> bool:
        return self.devices[name] == SWITCH
