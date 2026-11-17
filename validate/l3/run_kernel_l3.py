#!/usr/bin/env python3
"""Proof of concept #3: the OpenPacketRouter engine vs real Linux routers, clients and servers.

    sudo python3 validate/l3/run_kernel_l3.py

For each network spec (fti-routed, fti-loop, fti-noreturn) this builds the same
network from Linux network namespaces: every client, server and router is its
own Linux network stack (routers forward with the kernel's IP routing), every
switch is a kernel bridge, every cable a veth pair. It runs the same actions as
the engine (engine/tools/run_spec.mjs), with ARP caches and MAC tables flushed
before each, and compares the results and the frame count on every cable
direction. Linux settings that change which frames appear are pinned to what
the engine models: ICMP redirects off, ICMP rate limiting off, rp_filter off.
"""
import json, os, re, shutil, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
SPECS = ["fti-routed", "fti-loop", "fti-noreturn"]


def sh(*a, check=True):
    return subprocess.run(a, check=check, capture_output=True, text=True).stdout


def nsx(ns, *a, check=True):
    return sh("ip", "netns", "exec", ns, *a, check=check)


def sysctl(ns, key, val):
    nsx(ns, "sh", "-c", f"echo {val} > /proc/sys/{key.replace('.', '/')}")


class KernelNet:
    def __init__(self, spec):
        self.spec = spec; self.procs = []; self.ifmap = {}
        os.makedirs("/run/netns", exist_ok=True)
        self.ns = {n["name"]: "n-" + n["name"] for n in spec["nodes"]}
        for n in spec["nodes"]:
            ns = self.ns[n["name"]]; sh("ip", "netns", "add", ns); sh("ip", "-n", ns, "link", "set", "lo", "up")
            for k, v in [("net.ipv4.conf.all.send_redirects", 0), ("net.ipv4.conf.default.send_redirects", 0), ("net.ipv4.icmp_ratelimit", 0),
                         ("net.ipv4.conf.all.rp_filter", 0), ("net.ipv4.conf.default.rp_filter", 0),
                         ("net.ipv4.ip_forward", 1 if n["kind"] == "router" else 0)]:
                sysctl(ns, k, v)
            if n["kind"] == "switch":
                sh("ip", "-n", ns, "link", "add", "br0", "type", "bridge", "stp_state", "0"); sh("ip", "-n", ns, "link", "set", "br0", "up")
        kind = {n["name"]: n["kind"] for n in spec["nodes"]}
        for k, (a, b, *_rest) in enumerate(spec["links"]):
            ta, tb = f"va{k}", f"vb{k}"
            sh("ip", "link", "add", ta, "type", "veth", "peer", "name", tb)
            for tmp, ref in ((ta, a), (tb, b)):
                node, ifn = ref.split(":"); ns = self.ns[node]
                sh("ip", "link", "set", tmp, "netns", ns, "name", ifn)
                if kind[node] == "switch": sh("ip", "-n", ns, "link", "set", ifn, "master", "br0")
                sh("ip", "-n", ns, "link", "set", ifn, "up")
                sysctl(ns, f"net.ipv4.conf.{ifn}.send_redirects", 0); sysctl(ns, f"net.ipv4.conf.{ifn}.rp_filter", 0)
            self.ifmap[(a.split(":")[0], a.split(":")[1])] = b
            self.ifmap[(b.split(":")[0], b.split(":")[1])] = a
        for n in spec["nodes"]:
            ns = self.ns[n["name"]]
            for ifn, cidr in (n.get("ifaces") or {}).items(): sh("ip", "-n", ns, "addr", "add", cidr, "dev", ifn)
            for dst, via in n.get("routes", []): sh("ip", "-n", ns, "route", "add", dst, "via", via)
            if n.get("gw"): sh("ip", "-n", ns, "route", "add", "default", "via", n["gw"])
            if n.get("services", {}).get("dns"):
                self.procs.append(subprocess.Popen(["ip", "netns", "exec", ns, sys.executable, str(HERE / "dns_server.py"), json.dumps(n["services"]["dns"])]))
        time.sleep(0.5)

    def flush(self):
        for n in self.spec["nodes"]:
            ns = self.ns[n["name"]]
            if n["kind"] == "switch": sh("ip", "-n", ns, "link", "set", "br0", "type", "bridge", "fdb_flush")
            else: sh("ip", "-n", ns, "neigh", "flush", "all")

    def counters(self):
        c = {}
        for n in self.spec["nodes"]:
            for l in json.loads(sh("ip", "-n", self.ns[n["name"]], "-s", "-j", "link", "show")):
                peer = self.ifmap.get((n["name"], l["ifname"]))
                if peer: c[f'{n["name"]}:{l["ifname"]}>{peer}'] = l["stats64"]["tx"]["packets"]
        return c

    def act(self, a):
        probe = [sys.executable, str(HERE / "probe.py")]
        ns = self.ns[a["src"]]
        if a["do"] == "ping": args = ["ping", a["dst"], str(a.get("ttl", 64)), str(a.get("timeout", 2))]
        elif a["do"] == "traceroute": args = ["traceroute", a["dst"], str(a.get("maxHops", 8))]
        elif a["do"] == "dns": args = ["dns", a["server"], a["name"]]
        elif a["do"] == "udp": args = ["udp", a["dst"], str(a["port"])]
        return json.loads(nsx(ns, *probe, *args))

    def close(self):
        for p in self.procs: p.kill()
        for ns in self.ns.values(): sh("ip", "netns", "del", ns, check=False)


def kernel_run(name):
    spec = json.loads((HERE / f"{name}.json").read_text()); actions = json.loads((HERE / f"{name}.actions.json").read_text())
    k = KernelNet(spec); out = []
    try:
        for a in actions:
            k.flush(); before = k.counters(); r = k.act(a); time.sleep(a.get("settle", 1)); after = k.counters()
            out.append({"action": a, "result": r, "frames": {key: after[key] - before.get(key, 0) for key in after if after[key] - before.get(key, 0)}})
    finally:
        k.close()
    return out


def inner():
    # fresh mount namespace: private /run/netns
    sh("mount", "-t", "tmpfs", "none", "/run")
    print(json.dumps({name: kernel_run(name) for name in SPECS}))


def comparable(r):
    r = {k: v for k, v in r.items() if k != "rtt_ms"}
    if "hops" in r: r["hops"] = [{k: h[k] for k in ("ttl", "from", "kind")} for h in r["hops"]]
    return r


def main():
    if os.geteuid() != 0 or not shutil.which("unshare") or not shutil.which("ip"):
        print("Needs root, `unshare` and iproute2. Skipping."); return 0
    kern = json.loads(subprocess.run(["unshare", "-n", "-m", sys.executable, __file__, "--inner"], check=True, capture_output=True, text=True, timeout=600).stdout)
    rows, ok_all, detail = [], True, {}
    for name in SPECS:
        eng = json.loads(sh("node", str(ROOT / "engine" / "tools" / "run_spec.mjs"), str(HERE / f"{name}.json"), str(HERE / f"{name}.actions.json")))
        for e, k in zip(eng, kern[name]):
            a = e["action"]; same_result = comparable(e["result"]) == comparable(k["result"])
            keys = sorted(set(e["frames"]) | set(k["frames"]))
            diffs = {key: (e["frames"].get(key, 0), k["frames"].get(key, 0)) for key in keys if e["frames"].get(key, 0) != k["frames"].get(key, 0)}
            ok = same_result and not diffs; ok_all &= ok
            what = f'{a["do"]} {a["src"]} → {a.get("dst", a.get("server"))}' + (f' ({a["name"]})' if "name" in a else "") + (f' port {a["port"]}' if "port" in a else "")
            res = e["result"]
            summary = ("reached" if res.get("reached") else "not reached") + " · " + " → ".join(h["from"] or "*" for h in res["hops"]) if "hops" in res else \
                ("ok" if res.get("ok") else res.get("error", "?")) + (f' from {res["from"]}' if res.get("from") else "") + (f' · answer {res["answer"]}' if res.get("answer") else "")
            rows.append((name, what, summary, f'{sum(e["frames"].values())} frames on {len(e["frames"])} cable directions', "✓" if ok else "✗"))
            if not ok: detail[f"{name}: {what}"] = {"engine": comparable(e["result"]), "kernel": comparable(k["result"]), "frame_diffs": diffs}
    md = ["| Network | Action | Engine result (same in Linux?) | Frames (engine = Linux, cable by cable?) | Match |", "|---|---|---|---|---|"]
    md += [f"| {a} | {b} | {c} | {d} | {e} |" for a, b, c, d, e in rows]
    (ROOT / "validate" / "l3" / "results.md").write_text("\n".join(md) + "\n")
    (ROOT / "validate" / "l3" / "mismatches.json").write_text(json.dumps(detail, indent=1))
    print("\n".join(md))
    if detail: print(json.dumps(detail, indent=1)[:4000])
    return 0 if ok_all else 1


if __name__ == "__main__":
    if sys.argv[1:] == ["--inner"]: inner()
    else: sys.exit(main())
