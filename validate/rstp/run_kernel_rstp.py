#!/usr/bin/env python3
"""RSTP: the engine vs real Linux bridges run by mstpd (CI only; needs root, mstpd and mstpctl on the host).

Linux hands spanning tree to a userspace daemon (mstpd, bridge `stp_state 2`) only in the initial network namespace,
so these bridges live there, joined by veth pairs; an unattached veth end stands for a host. Run:

    sudo python3 validate/rstp/run_kernel_rstp.py --explore SPEC.json SECONDS [cut SW:port AT]...   # print a timeline
"""
import json, os, re, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def sh(*a, check=True):
    r = subprocess.run(a, capture_output=True, text=True)
    if check and r.returncode: raise RuntimeError(f"{' '.join(a)}: {r.stderr.strip()}")
    return r.stdout


class Bridges:
    def __init__(self, spec):
        self.spec = spec; self.sw = {n["name"]: n for n in spec["nodes"] if n["kind"] == "switch"}
        self.br = {n: n.lower() for n in self.sw}                       # bridge names
        self.ifn = {}                                                    # "SW:port" -> interface name
        self.sniff = []; self.files = {}
        self.t0 = None

    def up(self):
        for n, node in self.sw.items():
            s = node.get("stp", {})
            sh("ip", "link", "add", self.br[n], "type", "bridge"); sh("ip", "link", "set", self.br[n], "address", s["mac"])
            sh("sysctl", "-qw", f"net.ipv6.conf.{self.br[n]}.disable_ipv6=1", check=False)
        for i, (a, b) in enumerate(self.spec["links"]):
            ends = []
            for e in (a, b):
                node, port = e.split(":"); ends.append((node, port, f"{node.lower()}-{port}"))
            sh("ip", "link", "add", ends[0][2], "type", "veth", "peer", "name", ends[1][2])
            for node, port, name in ends:
                self.ifn[f"{node}:{port}"] = name
                sh("sysctl", "-qw", f"net.ipv6.conf.{name}.disable_ipv6=1", check=False)
                if node in self.sw: sh("ip", "link", "set", name, "master", self.br[node])
        self.pids = subprocess.Popen(["mstpd", "-d", "-v", "2"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1)
        for n, node in self.sw.items():
            s = node.get("stp", {}); b = self.br[n]
            sh("ip", "link", "set", b, "type", "bridge", "stp_state", "2")
        time.sleep(0.5)
        for n, node in self.sw.items():
            s = node.get("stp", {}); b = self.br[n]
            sh("mstpctl", "setforcevers", b, "rstp")
            sh("mstpctl", "sethello", b, str(s.get("hello", 2))); sh("mstpctl", "setmaxage", b, str(s.get("maxAge", 20))); sh("mstpctl", "setfdelay", b, str(s.get("forwardDelay", 15)))
            sh("mstpctl", "settreeprio", b, "0", str(s.get("priority", 0x8000) >> 12))
            for port, cost in (s.get("cost") or {}).items(): sh("mstpctl", "setportpathcost", b, self.ifn[f"{n}:{port}"], str(cost))
        for f in os.listdir("/tmp"):
            if f.startswith("rstp-bpdu-"): os.remove("/tmp/" + f)
        for key, name in self.ifn.items():
            f = f"/tmp/rstp-bpdu-{name}.txt"; open(f, "w").close(); self.files[key] = f
            self.sniff.append(subprocess.Popen([sys.executable, str(HERE / "sniff_bpdu.py"), name, f]))
        time.sleep(0.5)
        for b in self.br.values(): sh("ip", "link", "set", b, "up")
        for name in self.ifn.values(): sh("ip", "link", "set", name, "up")
        self.t0 = time.monotonic()

    def link(self, end, up):
        sh("ip", "link", "set", self.ifn[end], "up" if up else "down")
        peer = self.peer(end)
        if peer: sh("ip", "link", "set", self.ifn[peer], "up" if up else "down")

    def peer(self, end):
        for a, b in self.spec["links"]:
            if a == end: return b
            if b == end: return a

    def ports(self, sw):
        """{port: {role, state, ...}} from mstpctl showport (columns after the name: id state root bridge bridge-port role)."""
        out = {}
        inv = {v: k.split(":")[1] for k, v in self.ifn.items() if k.startswith(sw + ":")}
        for line in sh("mstpctl", "showport", self.br[sw], check=False).splitlines():
            t = line.split()
            if len(t) < 7 or t[-7] not in inv: continue
            out[inv[t[-7]]] = {"id": t[-6], "state": t[-5], "root": t[-4], "bridge": t[-3], "port": t[-2], "role": t[-1]}
        return out

    def close(self):
        for p in self.sniff: p.kill()
        subprocess.run(["pkill", "mstpd"])
        for b in self.br.values(): sh("ip", "link", "del", b, check=False)
        for name in self.ifn.values(): sh("ip", "link", "del", name, check=False)


def explore(spec_file, seconds, events):
    spec = json.loads(Path(spec_file).read_text()); k = Bridges(spec)
    try:
        k.up(); ev = sorted(events); seen = {}
        while True:
            t = time.monotonic() - k.t0
            while ev and ev[0][0] <= t: _, end, up = ev.pop(0); k.link(end, up); print(f"{t:6.2f} LINK {end} {'up' if up else 'down'}")
            row = []
            for sw in k.sw:
                row.append(sw + " " + " ".join(f"{p}:{v['role'][:4]}/{v['state'][:4]}" for p, v in sorted(k.ports(sw).items())))
            line = " | ".join(row)
            if line != seen.get("row"): print(f"{t:6.2f} {line}"); seen["row"] = line
            if t > seconds: break
            time.sleep(0.1)
        rows = []
        for key, f in k.files.items():
            for l in open(f).read().splitlines():
                tt, v, ty, fl = l.split(); rows.append((float(tt) - k.t0, f"{float(tt) - k.t0:6.2f} BPDU {key} v{v} type{ty} flags={fl}"))
        for _, r in sorted(rows): print(r)
    finally: k.close()


if __name__ == "__main__":
    if sys.argv[1] == "--explore":
        evs = []; a = sys.argv[4:]
        while a: evs.append((float(a[2]), a[1], a[0] == "restore" and True or False)); a = a[3:]
        explore(sys.argv[2], float(sys.argv[3]), [(t, e, u) for t, e, u in evs])
