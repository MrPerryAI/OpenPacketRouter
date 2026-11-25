#!/usr/bin/env python3
"""RSTP: the engine vs real Linux bridges run by mstpd (CI only; needs root, mstpd and mstpctl on the host).

Linux hands spanning tree to a userspace daemon (mstpd, bridge `stp_state 2`) only in the initial network namespace,
so these bridges live there, joined by veth pairs; an unattached veth end stands for a host. Run:

    sudo python3 validate/rstp/run_kernel_rstp.py                                  # run the cases below, engine vs kernel
    sudo python3 validate/rstp/run_kernel_rstp.py --explore SPEC.json SECONDS [cut|restore SW:port AT]...   # print a timeline

Each case (tri.json + tri.steps.json) runs the same steps on the engine (engine/tools/run_rstp.mjs) and on the kernel bridges:
waits, cable cuts and returns, snapshots of every bridge (root, root port, path cost, each port's role, state and edge flag
from mstpctl) and the kinds of BPDU (flags bytes) each cable direction sent in a window. Snapshots and windows sit on plateaus,
away from the daemon's one-second ticks.
"""
import json, os, re, shutil, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
CASES = [("tri", "tri.steps")]
DIAG = {}   # what the kernel side looked like, printed if a step does not match
ROLES = {"root": "root", "desg": "designated", "altn": "alternate", "back": "backup", "disa": "disabled"}
STATES = {"forw": "forwarding", "disc": "discarding", "lear": "learning", "down": "disabled"}


def sh(*a, check=True):
    r = subprocess.run(a, capture_output=True, text=True)
    if check and r.returncode: raise RuntimeError(f"{' '.join(a)}: {r.stderr.strip()} {r.stdout.strip()}")
    return r.stdout


class Bridges:
    def __init__(self, spec):
        self.spec = spec; self.sw = {n["name"]: n for n in spec["nodes"] if n["kind"] == "switch"}
        self.br = {n: n.lower() for n in self.sw}                       # bridge names
        self.ifn = {}                                                    # "SW:port" -> interface name
        self.sniff = []; self.files = {}
        self.t0 = None; self.marks = {}

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
            sh("ip", "link", "set", b, "type", "bridge", "stp_state", "2"); sh("ip", "link", "set", b, "up")
        time.sleep(1)
        for n, node in self.sw.items():
            s = node.get("stp", {}); b = self.br[n]
            sh("mstpctl", "setforcevers", b, "rstp")
            sh("mstpctl", "sethello", b, str(s.get("hello", 2))); sh("mstpctl", "setmaxage", b, str(s.get("maxAge", 20))); sh("mstpctl", "setfdelay", b, str(s.get("forwardDelay", 15)))
            sh("mstpctl", "settreeprio", b, "0", str(s.get("priority", 0x8000) >> 12))
        for name in self.ifn.values(): sh("ip", "link", "set", name, "up")   # mstpd only knows a port once it has been up: bring them up, then down again to configure them
        time.sleep(1)
        for name in self.ifn.values(): sh("ip", "link", "set", name, "down")
        time.sleep(0.5)
        for n, node in self.sw.items():
            s = node.get("stp", {})
            for key, name in self.ifn.items():
                if key.startswith(n + ":"): sh("mstpctl", "setportpathcost", self.br[n], name, str((s.get("cost") or {}).get(key.split(":")[1], 20000)))
        for f in os.listdir("/tmp"):
            if f.startswith("rstp-bpdu-"): os.remove("/tmp/" + f)
        for key, name in self.ifn.items():
            f = f"/tmp/rstp-bpdu-{name}.txt"; open(f, "w").close(); self.files[key] = f
            self.sniff.append(subprocess.Popen([sys.executable, str(HERE / "sniff_bpdu.py"), name, f]))
        time.sleep(0.5)
        for name in self.ifn.values(): sh("ip", "link", "set", name, "up")
        self.t0 = time.monotonic()

    def snapshot(self, names):
        out = {}
        for sw in names:
            b = self.br[sw]; inv = {v: k.split(":")[1] for k, v in self.ifn.items() if k.startswith(sw + ":")}
            info = sh("mstpctl", "showbridge", b)
            def f(rx):
                m = re.search(rx, info, re.M); return m.group(1) if m else None
            a, e, c = f(r"^\s*designated root\s+(\S+)").split(".")
            rp = f(r"^\s*root port\s+(\S+)")
            ports = {}
            for port, v in self.ports(sw).items():
                det = sh("mstpctl", "showportdetail", b, self.ifn[f"{sw}:{port}"])
                edge = re.search(r"oper edge port\s+(\w+)", det)
                ports[port] = {"role": ROLES[v["role"][:4].lower()], "state": STATES[v["state"][:4].lower()], "edge": bool(edge and edge.group(1) == "yes")}
            out[sw] = {"root": f"{a}{e}.{c.replace(':', '').lower()}", "rootPort": inv.get(rp), "rootCost": int(f(r"^\s*path cost\s+(\d+)")), "ports": ports}
        return out

    def window(self):
        """Kinds of BPDU each cable direction sent since the last call: {"SW1:p1>SW2:p1": [kinds]}."""
        time.sleep(0.2); out = {}
        for key, f in self.files.items():
            peer = self.peer(key); lines = open(f).read().splitlines(); done = self.marks.get(key, 0); self.marks[key] = len(lines)
            kinds = sorted({l.split()[1] for l in lines[done:]})
            if kinds: out[f"{key}>{peer}"] = kinds
        return out

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
                tt, kind = l.split(); rows.append((float(tt) - k.t0, f"{float(tt) - k.t0:6.2f} BPDU {key} {kind}"))
        for _, r in sorted(rows): print(r)
    finally: k.close()


def kernel(name, steps_name):
    spec = json.loads((HERE / f"{name}.json").read_text()); steps = json.loads((HERE / f"{steps_name}.json").read_text()); k = Bridges(spec); out = []
    try:
        k.up(); k.window()   # (the start-up exchange is not compared)
        DIAG[name] = {sw: {"link": sh("ip", "-br", "link", "show", k.br[sw]).strip(), "bridge": re.search(r"bridge id\s+(\S+)", sh("mstpctl", "showbridge", k.br[sw])).group(1)} for sw in k.sw}
        for s in steps:
            if "wait" in s: time.sleep(s["wait"])
            elif "link" in s: k.link(s["link"]["end"], s["link"]["up"])
            elif s.get("bpdus") == "mark": k.window()
            elif "bpdus" in s: out.append({"bpdus": True, "kinds": k.window()})
            elif "stp" in s: out.append({"stp": s["stp"], "bridges": k.snapshot(s["stp"])})
    finally: k.close()
    return out


def main():
    if os.geteuid() != 0 or not all(shutil.which(x) for x in ("ip", "mstpd", "mstpctl")):
        print("Needs root, iproute2 and mstpd/mstpctl on the host (CI only). Skipping."); return 0
    md = ["| Network | Step | Result | Match |", "|---|---|---|---|"]; ok_all = True; detail = {}
    for name, steps_name in CASES:
        kern = kernel(name, steps_name)
        eng = json.loads(sh("node", str(ROOT / "engine/tools/run_rstp.mjs"), str(HERE / f"{name}.json"), str(HERE / f"{steps_name}.json")))
        for i, (e, k) in enumerate(zip(eng, kern)):
            ok = e == k; ok_all &= ok
            if "bpdus" in e: label = "BPDU kinds per cable direction"; res = f'{len(e["kinds"])} cable directions with BPDUs'
            else:
                label = "bridges " + ", ".join(e["stp"])
                res = " · ".join(f'{sw}: ' + " ".join(f'{p}={v["role"][:4]}/{v["state"][:4]}' for p, v in b["ports"].items()) for sw, b in e["bridges"].items())
            md.append(f"| {name} | {i + 1}. {label} | {res} | {'✓' if ok else '✗'} |")
            if not ok: detail[f"{name} step {i + 1}: {label}"] = {"engine": e, "kernel": k}
        if len(eng) != len(kern): ok_all = False; detail[f"{name}: step count"] = {"engine": len(eng), "kernel": len(kern)}
    (HERE / "results.md").write_text("\n".join(md) + "\n"); (HERE / "mismatches.json").write_text(json.dumps(detail, indent=1))
    print("\n".join(md))
    if detail: print(json.dumps({**detail, "diag": DIAG}, indent=1)[:12000])
    return 0 if ok_all else 1


if __name__ == "__main__":
    if len(sys.argv) < 2: sys.exit(main())
    if sys.argv[1] == "--explore":
        evs = []; a = sys.argv[4:]
        while a: evs.append((float(a[2]), a[1], a[0] == "restore" and True or False)); a = a[3:]
        explore(sys.argv[2], float(sys.argv[3]), [(t, e, u) for t, e, u in evs])
