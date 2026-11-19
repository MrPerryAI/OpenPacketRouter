#!/usr/bin/env python3
"""Layer 2 validation: the engine's spanning tree and VLANs vs real Linux kernel bridges.

    sudo python3 validate/l2/run_kernel_l2.py        (inside a privileged Linux container on a Mac)

Spanning tree (stp-ring): each switch is a kernel bridge with stp_state 1, an explicit
bridge MAC/priority/timers and per-port path costs from the spec. After convergence, after a
cable is cut and after it is restored, the harness reads the kernel's view from sysfs (root
bridge, root path cost, and per port: state, designated root/cost/bridge/port) and derives each
port's role (root / designated / blocked). It compares all of it with the engine, plus ping
reachability. BPDU timing is not compared (the kernel's hello timers are not frame-deterministic).

VLANs (vlan-trunk, vlan-native): switches are bridges with vlan_filtering 1; access ports get
`pvid untagged`, trunks get tagged VIDs (and a native VID if given). Same actions as the engine,
results and per-cable frame counts compared, exactly like validate/l3.
"""
import json, os, shutil, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "validate" / "l3"))
from run_kernel_l3 import sh, nsx, sysctl, no_ipv6, comparable  # noqa: E402
import run_kernel_l3 as l3  # noqa: E402

VLAN = ["vlan-trunk", "vlan-native"]
STP = [("stp-ring", "stp-ring.steps"), ("stp-tiebreak", "stp-tiebreak.steps")]


class Net:
    def __init__(self, spec):
        self.spec = spec; self.ifmap = {}; self.ns = {n["name"]: "n-" + n["name"] for n in spec["nodes"]}
        os.makedirs("/run/netns", exist_ok=True); no_ipv6()
        self.kind = {n["name"]: n["kind"] for n in spec["nodes"]}; self.node = {n["name"]: n for n in spec["nodes"]}
        for n in spec["nodes"]:
            ns = self.ns[n["name"]]; sh("ip", "netns", "add", ns); no_ipv6(ns); sh("ip", "-n", ns, "link", "set", "lo", "up")
            routes = n["kind"] == "router" or (n["kind"] == "switch" and n.get("ifaces"))   # a switch with SVIs is a Layer 3 switch
            for k, v in [("net.ipv4.conf.all.send_redirects", 0), ("net.ipv4.conf.default.send_redirects", 0), ("net.ipv4.icmp_ratelimit", 0),
                         ("net.ipv4.conf.all.rp_filter", 0), ("net.ipv4.conf.default.rp_filter", 0), ("net.ipv4.ip_forward", 1 if routes else 0)]:
                sysctl(ns, k, v)
            if n["kind"] == "switch":
                cmd = ["ip", "-n", ns, "link", "add", "br0", "type", "bridge", "stp_state", "0"]
                if n.get("stp"):
                    s = n["stp"]; cmd[-1] = "1"
                    cmd += ["priority", str(s.get("priority", 32768)), "hello_time", str(int(s.get("hello", 2) * 100)),
                            "max_age", str(int(s.get("maxAge", 20) * 100)), "forward_delay", str(int(s.get("forwardDelay", 15) * 100))]
                sh(*cmd)
                if n.get("stp"): sh("ip", "-n", ns, "link", "set", "br0", "address", n["stp"]["mac"])
                if n.get("vlans"): sh("ip", "-n", ns, "link", "set", "br0", "type", "bridge", "vlan_filtering", "1")
                no_ipv6(ns, "br0"); sh("ip", "-n", ns, "link", "set", "br0", "up")
        for k, (a, b, *_r) in enumerate(spec["links"]):
            ta, tb = f"va{k}", f"vb{k}"; sh("ip", "link", "add", ta, "type", "veth", "peer", "name", tb)
            for tmp, ref in ((ta, a), (tb, b)):
                node, ifn = ref.split(":"); ns = self.ns[node]
                sh("ip", "link", "set", tmp, "netns", ns, "name", ifn); no_ipv6(ns, ifn)
                if self.kind[node] == "switch":
                    sh("ip", "-n", ns, "link", "set", ifn, "master", "br0")
                    cost = ((self.node[node].get("stp") or {}).get("cost") or {}).get(ifn, 19)
                    if self.node[node].get("stp"): sh("ip", "-n", ns, "link", "set", ifn, "type", "bridge_slave", "cost", str(cost))
                    self.vlan(ns, node, ifn)
                sh("ip", "-n", ns, "link", "set", ifn, "up")
                sysctl(ns, f"net.ipv4.conf.{ifn}.send_redirects", 0); sysctl(ns, f"net.ipv4.conf.{ifn}.rp_filter", 0)
            self.ifmap[tuple(a.split(":"))] = b; self.ifmap[tuple(b.split(":"))] = a
        for n in spec["nodes"]:
            ns = self.ns[n["name"]]
            for ifn in (n.get("ifaces") or {}): self.virtual(ns, n, ifn)
            for ifn, cidr in (n.get("ifaces") or {}).items(): sh("ip", "-n", ns, "addr", "add", cidr, "dev", ifn)
            for dst, via in n.get("routes", []): sh("ip", "-n", ns, "route", "add", dst, "via", via)
            if n.get("gw"): sh("ip", "-n", ns, "route", "add", "default", "via", n["gw"])
        time.sleep(0.5)

    def virtual(self, ns, n, ifn):
        """VLAN interfaces: a router's "eth0.10" is an 802.1Q subinterface of eth0; a switch's "vlan10" is an
        SVI, a vlan device on the bridge itself (br0 carries VLAN 10 tagged to its own stack)."""
        if n["kind"] == "switch":
            vid = ifn[4:]
            if not getattr(self, "_br_self", {}).get(ns):
                sh("ip", "netns", "exec", ns, "bridge", "vlan", "del", "dev", "br0", "vid", "1", "self")   # br0 is untagged VLAN 1 by default
                self._br_self = {**getattr(self, "_br_self", {}), ns: True}
            sh("ip", "netns", "exec", ns, "bridge", "vlan", "add", "dev", "br0", "vid", vid, "self")
            sh("ip", "-n", ns, "link", "add", "link", "br0", "name", ifn, "type", "vlan", "id", vid)
        elif "." in ifn:
            parent, vid = ifn.split(".")
            sh("ip", "-n", ns, "link", "add", "link", parent, "name", ifn, "type", "vlan", "id", vid)
        else: return
        no_ipv6(ns, ifn); sh("ip", "-n", ns, "link", "set", ifn, "up")
        sysctl(ns, f"net.ipv4.conf.{ifn}.send_redirects", 0); sysctl(ns, f"net.ipv4.conf.{ifn}.rp_filter", 0)

    def vlan(self, ns, node, ifn):
        vl = self.node[node].get("vlans")
        if vl is None: return
        c = vl.get(ifn, {"access": 1})
        sh("ip", "netns", "exec", ns, "bridge", "vlan", "del", "dev", ifn, "vid", "1")
        if "access" in c: sh("ip", "netns", "exec", ns, "bridge", "vlan", "add", "dev", ifn, "vid", str(c["access"]), "pvid", "untagged")
        else:
            for v in c["trunk"]: sh("ip", "netns", "exec", ns, "bridge", "vlan", "add", "dev", ifn, "vid", str(v))
            if c.get("native") is not None: sh("ip", "netns", "exec", ns, "bridge", "vlan", "add", "dev", ifn, "vid", str(c["native"]), "pvid", "untagged")

    def flush(self):
        for n in self.spec["nodes"]:
            ns = self.ns[n["name"]]
            if n["kind"] == "switch": sh("ip", "-n", ns, "link", "set", "br0", "type", "bridge", "fdb_flush")
            if n["kind"] != "switch" or n.get("ifaces"): sh("ip", "-n", ns, "neigh", "flush", "all")

    def counters(self):
        c = {}
        for n in self.spec["nodes"]:
            for l in json.loads(sh("ip", "-n", self.ns[n["name"]], "-s", "-j", "link", "show")):
                peer = self.ifmap.get((n["name"], l["ifname"]))
                if peer: c[f'{n["name"]}:{l["ifname"]}>{peer}'] = l["stats64"]["tx"]["packets"]
        return c

    def ping(self, src, dst, timeout=2):
        out = nsx(self.ns[src], sys.executable, str(ROOT / "validate" / "l3" / "probe.py"), "ping", dst, "64", str(timeout))
        return json.loads(out)

    def sysfs(self, ns, path): return nsx(ns, "cat", path).strip()

    def snapshot(self):
        """The kernel's spanning-tree state in the same shape as engine/tools/run_stp.mjs."""
        STATE = {"0": "disabled", "1": "listening", "2": "learning", "3": "forwarding", "4": "blocking"}
        out = {}
        for n in self.spec["nodes"]:
            if not n.get("stp"): continue
            ns = self.ns[n["name"]]; b = "/sys/class/net/br0/bridge/"
            bid = self.sysfs(ns, b + "bridge_id"); root_port = int(self.sysfs(ns, b + "root_port"), 0)
            ports = {}
            for ifn in [l["ifname"] for l in json.loads(sh("ip", "-n", ns, "-j", "link", "show", "master", "br0"))]:
                p = f"/sys/class/net/br0/brif/{ifn}/"
                no = int(self.sysfs(ns, p + "port_no"), 0); pid = int(self.sysfs(ns, p + "port_id"), 0)
                dbr = self.sysfs(ns, p + "designated_bridge"); dport = int(self.sysfs(ns, p + "designated_port"), 0)
                state = STATE[self.sysfs(ns, p + "state")]
                role = "disabled" if state == "disabled" else "root" if no == root_port else "designated" if (dbr == bid and dport == pid) else "blocked"
                ports[ifn] = {"role": role, "state": state, "designatedCost": int(self.sysfs(ns, p + "designated_cost")),
                              "designatedBridge": dbr, "designatedPort": dport}
            out[n["name"]] = {"root": self.sysfs(ns, b + "root_id"), "bridgeId": bid, "rootCost": int(self.sysfs(ns, b + "root_path_cost")), "ports": ports}
        return out

    def link(self, ref, up):
        node, ifn = ref.split(":"); sh("ip", "-n", self.ns[node], "link", "set", ifn, "up" if up else "down")

    def close(self):
        for ns in self.ns.values(): sh("ip", "netns", "del", ns, check=False)


def kernel_vlan(name):
    spec = json.loads((HERE / f"{name}.json").read_text()); acts = json.loads((HERE / f"{name}.actions.json").read_text())
    k = Net(spec); out = []
    try:
        for a in acts:
            k.flush(); before = k.counters(); r = k.ping(a["src"], a["dst"], a.get("timeout", 2)); time.sleep(a.get("settle", 1)); after = k.counters()
            out.append({"action": a, "result": r, "frames": {x: after[x] - before.get(x, 0) for x in after if after[x] - before.get(x, 0)}})
    finally: k.close()
    return out


def kernel_stp(name, steps_name):
    spec = json.loads((HERE / f"{name}.json").read_text()); steps = json.loads((HERE / f"{steps_name}.json").read_text())
    k = Net(spec); out = []
    try:
        for s in steps:
            if "wait" in s: time.sleep(s["wait"])
            elif "linkDown" in s: k.link(s["linkDown"], False)
            elif "linkUp" in s: k.link(s["linkUp"], True)
            elif "ping" in s: out.append({"ping": s["ping"], "ok": bool(k.ping(*s["ping"]).get("ok"))})
            elif "snapshot" in s: out.append({"snapshot": s["snapshot"], "bridges": k.snapshot()})
    finally: k.close()
    return out


def inner():
    sh("mount", "-t", "tmpfs", "none", "/run")
    print(json.dumps({"vlan": {n: kernel_vlan(n) for n in VLAN}, "stp": {n: kernel_stp(n, s) for n, s in STP}}))


def main():
    if os.geteuid() != 0 or not shutil.which("unshare") or not shutil.which("ip") or not shutil.which("bridge"):
        print("Needs root, `unshare`, iproute2 (ip, bridge). Skipping."); return 0
    proc = subprocess.run(["unshare", "-n", "-m", sys.executable, __file__, "--inner"], capture_output=True, text=True, timeout=900)
    if proc.returncode:
        print("kernel side failed:\n" + proc.stderr[-3000:]); l3.gh_note("error", "L2 kernel side failed", proc.stderr[-6000:]); return 1
    kern = json.loads(proc.stdout)
    md = ["| Network | Check | Result | Match |", "|---|---|---|---|"]; ok_all = True; detail = {}
    for name in VLAN:
        eng = json.loads(sh("node", str(ROOT / "engine/tools/run_spec.mjs"), str(HERE / f"{name}.json"), str(HERE / f"{name}.actions.json")))
        for e, k in zip(eng, kern["vlan"][name]):
            a = e["action"]; same = comparable(e["result"]) == comparable(k["result"])
            keys = set(e["frames"]) | set(k["frames"]); diffs = {x: (e["frames"].get(x, 0), k["frames"].get(x, 0)) for x in keys if e["frames"].get(x, 0) != k["frames"].get(x, 0)}
            ok = same and not diffs; ok_all &= ok
            md.append(f'| {name} | ping {a["src"]} → {a["dst"]} | {"ok" if e["result"].get("ok") else "no reply"} · {sum(e["frames"].values())} frames on {len(e["frames"])} cable directions | {"✓" if ok else "✗"} |')
            if not ok: detail[f'{name}: {a}'] = {"engine": e, "kernel": k, "frame_diffs": diffs}
    for name, steps_name in STP:
        eng = json.loads(sh("node", str(ROOT / "engine/tools/run_stp.mjs"), str(HERE / f"{name}.json"), str(HERE / f"{steps_name}.json")))
        for e, k in zip(eng, kern["stp"][name]):
            ok = e == k; ok_all &= ok
            label = e.get("snapshot") or f'ping {e["ping"][0]} → {e["ping"][1]}'
            md.append(f'| {name} | {label} | {"roles, states, costs" if "bridges" in e else ("reachable" if e["ok"] else "unreachable")} | {"✓" if ok else "✗"} |')
            if not ok: detail[f"{name}: {label}"] = {"engine": e, "kernel": k}
    (HERE / "results.md").write_text("\n".join(md) + "\n"); (HERE / "mismatches.json").write_text(json.dumps(detail, indent=1))
    print("\n".join(md))
    if detail: print(json.dumps(detail, indent=1)[:6000]); l3.gh_note("error", "L2 engine vs Linux mismatch", json.dumps(detail))
    return 0 if ok_all else 1


if __name__ == "__main__":
    if sys.argv[1:] == ["--inner"]: inner()
    else: sys.exit(main())
