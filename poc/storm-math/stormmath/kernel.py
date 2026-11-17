"""Proof of concept #2: run a lab topology on REAL Linux kernel bridges.

Every switch in a `Topology` becomes a Linux bridge (STP off). Every switch
port is a veth pair: one end enslaved to the bridge, the other ("tap") read
and written by this module through an AF_PACKET socket. Cables are emulated
in user space: a frame read from one end's tap is written to the other end's
tap after the link's delay. Hosts and routers are endpoints in this module:
they absorb frames and can inject a broadcast.

So the kernel decides all flooding (the thing under test); this module only
supplies the cables, a clock and the counting. Must run as root inside a
fresh network namespace (see run_kernel.py, which re-executes itself under
`unshare -n`). Only ARP frames from our own injected MAC are relayed; any
other frame the kernel emits (IPv6 chatter etc.) is dropped and ignored.
"""
from __future__ import annotations

import heapq
import os
import select
import socket
import subprocess
import time
from dataclasses import dataclass, field

from .topology import SWITCH, Topology

ETH_P_ALL = 0x0003
PACKET_OUTGOING = 4
HOST_MAC = bytes.fromhex("020000000001")
ARP_FRAME = (b"\xff" * 6 + HOST_MAC + b"\x08\x06" +
             bytes.fromhex("0001080006040001") + HOST_MAC + bytes([10, 200, 0, 11]) + b"\x00" * 6 + bytes([10, 200, 0, 50]))


def sh(*args: str) -> None:
    subprocess.run(args, check=True, capture_output=True)


@dataclass
class Port:
    """One end of an emulated cable as seen by the relay."""
    link: int
    device: str
    sock: socket.socket | None = None   # tap socket when `device` is a switch


@dataclass
class KernelResult:
    tx: list[tuple[float, int]] = field(default_factory=list)  # (time since injection, directed-edge index)
    deliveries: dict[str, int] = field(default_factory=dict)
    drops: int = 0
    first_drop: float | None = None   # seconds after injection
    late: list[tuple[float, float]] = field(default_factory=list)  # (time, how late a delivery was)
    other_frames: int = 0
    stopped: str = ""


def build(topo: Topology) -> dict[tuple[int, str], Port]:
    """Create bridges and veth pairs for every forwarding switch port."""
    for knob in ("all", "default"):  # stop IPv6 chatter if this kernel has IPv6 at all
        try:
            with open(f"/proc/sys/net/ipv6/conf/{knob}/disable_ipv6", "w") as f:
                f.write("1")
        except OSError:
            pass
    sh("ip", "link", "set", "lo", "up")
    bridges = {d: f"br{i}" for i, d in enumerate(sorted(d for d, k in topo.devices.items() if k == SWITCH))}
    for d, br in bridges.items():
        sh("ip", "link", "add", br, "type", "bridge", "stp_state", "0", "forward_delay", "0")
        sh("ip", "link", "set", br, "up")
    ports: dict[tuple[int, str], Port] = {}
    usable = {e.link for e in topo.directed_edges()}
    for l in topo.links:
        if l.id not in usable:
            continue  # a blocked port: the cable carries nothing
        for dev in (l.a, l.b):
            p = Port(l.id, dev)
            if dev in bridges:
                pi, ti = f"p{l.id}{dev[:3]}{dev[-2:]}"[:15], f"t{l.id}{dev[:3]}{dev[-2:]}"[:15]
                sh("ip", "link", "add", pi, "type", "veth", "peer", "name", ti)
                sh("ip", "link", "set", pi, "master", bridges[dev])
                for i in (pi, ti):
                    sh("ip", "link", "set", i, "up")
                s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(ETH_P_ALL))
                s.bind((ti, 0))
                s.setblocking(False)
                p.sock = s
            ports[(l.id, dev)] = p
    time.sleep(0.3)  # let interfaces settle; drain anything they emitted
    for p in ports.values():
        if p.sock:
            try:
                while True:
                    p.sock.recv(65535)
            except BlockingIOError:
                pass
    return ports


def run(topo: Topology, ports: dict[tuple[int, str], Port], host: str, duration: float,
        delays: dict[int, float], max_frames: int = 200_000, queue_limit: int = 60) -> KernelResult:
    """Inject one ARP broadcast from `host` and relay frames for `duration` seconds.

    delays[link_id] is the one-way cable delay. A cable direction holds at most
    `queue_limit` frames in flight; beyond that frames are dropped (a full link).
    """
    edges = topo.directed_edges()
    edge_of = {(e.link, e.tail): i for i, e in enumerate(edges)}
    other = {}
    for l in topo.links:
        other[(l.id, l.a)] = l.b
        other[(l.id, l.b)] = l.a
    by_fd = {p.sock.fileno(): p for p in ports.values() if p.sock}
    inflight = [0] * len(edges)
    heap: list[tuple[float, int, int, int]] = []  # (due, seq, edge, link)
    res = KernelResult()
    seq = 0

    def transmit(link: int, tail: str, now: float):
        nonlocal seq
        i = edge_of.get((link, tail))
        if i is None:
            return
        if inflight[i] >= queue_limit:
            res.drops += 1
            if res.first_drop is None:
                res.first_drop = now - t0
            return
        inflight[i] += 1
        res.tx.append((now - t0, i))
        seq += 1
        heapq.heappush(heap, (now + delays[link], seq, i, link))

    t0 = time.perf_counter()
    for l in topo.links:  # the host puts one broadcast on its cable
        if host in (l.a, l.b) and (l.id, host) in ports:
            transmit(l.id, host, t0)
    end = t0 + duration
    while True:
        now = time.perf_counter()
        if now >= end:
            res.stopped = "time"
            break
        if len(res.tx) >= max_frames:
            res.stopped = "frame cap"
            break
        while heap and heap[0][0] <= now:  # deliver frames whose cable delay has passed
            due, _, i, link = heapq.heappop(heap)
            inflight[i] -= 1
            if len(res.late) < 50_000:
                res.late.append((now - t0, now - due))
            head = edges[i].head
            p = ports[(link, head)]
            if p.sock:
                p.sock.send(ARP_FRAME)  # into the bridge port
            else:
                res.deliveries[head] = res.deliveries.get(head, 0) + 1
        timeout = max(0.0, min(heap[0][0] - now if heap else 0.005, 0.005))
        ready, _, _ = select.select(list(by_fd), [], [], timeout)
        now = time.perf_counter()
        for fd in ready:
            p = by_fd[fd]
            while True:
                try:
                    data, addr = p.sock.recvfrom(65535)
                except BlockingIOError:
                    break
                if addr[2] == PACKET_OUTGOING:
                    continue  # our own write into the bridge port
                if data[6:12] != HOST_MAC or data[12:14] != b"\x08\x06":
                    res.other_frames += 1
                    continue
                transmit(p.link, p.device, now)  # the bridge flooded it out this port
    return res
