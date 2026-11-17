#!/usr/bin/env python3
"""Proof of concept #4: the engine's spanning tree and VLANs vs real Linux kernel bridges.

    sudo python3 validate/l2/run_kernel_l2.py [spec ...]

For each spec this builds the same network from Linux network namespaces: every
switch is a kernel bridge (spanning tree: `stp_state 1`, the kernel's own 802.1D;
VLANs: `vlan_filtering 1`), every host and router its own Linux network stack
(router-on-a-stick subinterfaces are Linux VLAN devices), every cable a veth pair.
The kernel is set up as a mirror of the engine's network: the same MACs, bridge
and port priorities, path costs, STP timers, port numbers and VLAN memberships
(read from `run_spec.mjs --describe`).

All bridges are switched on at the same moment; that moment is t = 0 in the
engine. Actions run at the same times ("at", seconds) in both. A sniffer in every
namespace sees every frame each interface sends, so per cable direction we get:
data frames, BPDUs, 802.1Q-tagged frames per VLAN, and the content of the last
BPDU. (Each count is cross-checked against the interface's own tx counter.)

What must match:
  traffic actions (ping …): the result, data frames per cable direction, and
      tagged frames per cable direction and VLAN, exactly;
  "stp": every bridge's root, root port and cost, topology-change flag, and every
      port's state, role, port id, cost and designated root/bridge/port/cost;
  "observe": which cable directions carry BPDUs and the content of the last BPDU
      on each, exactly; how many, within one (hello timers in the kernel are
      rounded to whole jiffies-seconds, so the phase differs).

VLAN specs need a kernel with 802.1Q (8021q, VLAN-aware bridges). Kernels
without it skip them (CI sets REQUIRE_VLAN=1 to make that a failure).
"""
import json, os, shutil, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE.parent / "l3"))
from run_kernel_l3 import sh, nsx, sysctl, no_ipv6  # noqa: E402

SPECS = ["stp-triangle", "stp-ring", "vlan-trunk", "vlan-native-mismatch", "vlan-stp"]
VLAN_SPECS = {"vlan-trunk", "vlan-native-mismatch", "vlan-stp"}
STATES = {0: "disabled", 1: "listening", 2: "learning", 3: "forwarding", 4: "blocking"}
TRAFFIC = ("ping", "traceroute", "dns", "udp")
cs = lambda s: str(round(s * 100))   # seconds -> centiseconds (ip link bridge timers)


class KernelL2:
    def __init__(self, spec, desc):
        self.spec, self.desc = spec, desc
        self.procs, self.sniffers, self.ifmap = [], {}, {}
        os.makedirs("/run/netns", exist_ok=True)
        no_ipv6()
        self.ns = {n["name"]: "n-" + n["name"] for n in spec["nodes"]}
        kind = {n["name"]: n["kind"] for n in spec["nodes"]}
        for n in spec["nodes"]:
            name, ns, d = n["name"], self.ns[n["name"]], desc[n["name"]]
            sh("ip", "netns", "add", ns); no_ipv6(ns); sh("ip", "-n", ns, "link", "set", "lo", "up")
            for k, v in [("net.ipv4.conf.all.send_redirects", 0), ("net.ipv4.conf.default.send_redirects", 0), ("net.ipv4.icmp_ratelimit", 0),
                         ("net.ipv4.conf.all.rp_filter", 0), ("net.ipv4.conf.default.rp_filter", 0),
                         ("net.ipv4.conf.all.arp_ignore", 1),   # answer ARP only for the receiving interface's own address, as the engine does
                         ("net.ipv4.ip_forward", 1 if n["kind"] == "router" else 0)]:
                sysctl(ns, k, v)
            if n["kind"] == "switch":
                args = ["ip", "-n", ns, "link", "add", "br0", "type", "bridge", "stp_state", "0"]
                if d["vlanAware"]: args += ["vlan_filtering", "1", "vlan_default_pvid", "0"]
                if d["stp"]:
                    st = d["stp"]
                    args += ["priority", str(st["priority"]), "hello_time", cs(st["hello"]), "forward_delay", cs(st["forwardDelay"]), "max_age", cs(st["maxAge"])]
                sh(*args); no_ipv6(ns, "br0")
                sh("ip", "-n", ns, "link", "set", "br0", "address", d["mac"])
        for k, (a, b, *_rest) in enumerate(spec["links"]):
            ta, tb = f"va{k}", f"vb{k}"
            sh("ip", "link", "add", ta, "type", "veth", "peer", "name", tb)
            for tmp, ref in ((ta, a), (tb, b)):
                node, ifn = ref.split(":"); ns = self.ns[node]
                sh("ip", "link", "set", tmp, "netns", ns, "name", ifn); no_ipv6(ns, ifn)
                sh("ip", "-n", ns, "link", "set", "dev", ifn, "address", desc[node]["ifaces"][ifn]["mac"])
                if kind[node] == "switch":
                    sh("ip", "-n", ns, "link", "set", "dev", ifn, "master", "br0")
                    p = desc[node]["ports"][ifn]
                    if desc[node]["stp"]:
                        nsx(ns, "bridge", "link", "set", "dev", ifn, "cost", str(p["cost"]), "priority", str(p["priority"] // 4))
                    if desc[node]["vlanAware"]:
                        for v in p["tagged"]: nsx(ns, "bridge", "vlan", "add", "dev", ifn, "vid", str(v))
                        for v in p["untagged"]: nsx(ns, "bridge", "vlan", "add", "dev", ifn, "vid", str(v), "untagged", *(["pvid"] if v == p["pvid"] else []))
                sh("ip", "-n", ns, "link", "set", "dev", ifn, "up")
                sysctl(ns, f"net.ipv4.conf.{ifn}.send_redirects", 0); sysctl(ns, f"net.ipv4.conf.{ifn}.rp_filter", 0)
            self.ifmap[tuple(a.split(":"))] = b
            self.ifmap[tuple(b.split(":"))] = a
        for n in spec["nodes"]:
            ns = self.ns[n["name"]]
            for ifn, i in desc[n["name"]]["ifaces"].items():
                if "parent" in i:
                    sh("ip", "-n", ns, "link", "add", "link", i["parent"], "name", ifn, "type", "vlan", "id", str(i["vlan"]))
                    no_ipv6(ns, ifn); sh("ip", "-n", ns, "link", "set", "dev", ifn, "up")
                    sysctl(ns, f"net.ipv4.conf.{ifn}.send_redirects", 0); sysctl(ns, f"net.ipv4.conf.{ifn}.rp_filter", 0)
            for ifn, cidr in (n.get("ifaces") or {}).items():
                if cidr: sh("ip", "-n", ns, "addr", "add", cidr, "dev", ifn)
            for dst, via in n.get("routes", []): sh("ip", "-n", ns, "route", "add", dst, "via", via)
            if n.get("gw"): sh("ip", "-n", ns, "route", "add", "default", "via", n["gw"])
            if n.get("services", {}).get("dns"):
                self.procs.append(subprocess.Popen(["ip", "netns", "exec", ns, sys.executable, str(HERE.parent / "l3" / "dns_server.py"), json.dumps(n["services"]["dns"])]))
        # the kernel numbers bridge ports in the order they join; so does the engine
        for n in spec["nodes"]:
            if n["kind"] != "switch": continue
            for ifn, p in desc[n["name"]]["ports"].items():
                no = int(nsx(self.ns[n["name"]], "cat", f"/sys/class/net/{ifn}/brport/port_no").strip(), 16)
                if no != p["no"]: raise RuntimeError(f'{n["name"]}:{ifn} is port {no} in Linux but {p["no"]} in the engine')
            if desc[n["name"]]["stp"]: sh("ip", "-n", self.ns[n["name"]], "link", "set", "br0", "type", "bridge", "stp_state", "1")
        for node, ns in self.ns.items():
            ifs = [i for (nd, i) in self.ifmap if nd == node]
            p = subprocess.Popen(["ip", "netns", "exec", ns, sys.executable, str(HERE / "sniff.py"), *ifs], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
            assert p.stdout.readline().strip() == "ready"
            self.sniffers[node] = p
        time.sleep(0.5)
        # power on: every bridge comes up together; that is t = 0
        script = "\n".join(f"ip -n {self.ns[n['name']]} link set br0 up" for n in spec["nodes"] if n["kind"] == "switch")
        t1 = time.monotonic(); sh("sh", "-c", script); t2 = time.monotonic()
        self.t0 = (t1 + t2) / 2

    def flush(self):
        for n in self.spec["nodes"]:
            ns = self.ns[n["name"]]
            if n["kind"] == "switch": sh("ip", "-n", ns, "link", "set", "br0", "type", "bridge", "fdb_flush")
            else: sh("ip", "-n", ns, "neigh", "flush", "all")

    def snapshot(self):
        sn = {}
        for node, p in self.sniffers.items(): p.stdin.write("dump\n"); p.stdin.flush()
        for node, p in self.sniffers.items():
            for ifn, s in json.loads(p.stdout.readline()).items(): sn[f"{node}:{ifn}>{self.ifmap[(node, ifn)]}"] = s
        return sn

    @staticmethod
    def diff(sn0, sn1):
        frames, bpdus, tagged, last, problems = {}, {}, {}, {}, []
        for key, s in sn1.items():
            s0 = sn0[key]
            total, bp = s["total"] - s0["total"], s["bpdu"] - s0["bpdu"]
            if s["tx"] - s0["tx"] != total:
                problems.append(f"{key}: sniffer saw {total} frames, tx counter says {s['tx'] - s0['tx']}")
            if total - bp: frames[key] = total - bp
            if bp: bpdus[key] = bp; last[key] = s["last"]
            for v, c in s["tagged"].items():
                if c - s0["tagged"].get(v, 0): tagged[f"{key}#{v}"] = c - s0["tagged"].get(v, 0)
        return frames, bpdus, tagged, last, problems

    def stp_report(self):
        rep = {}
        for n in self.spec["nodes"]:
            if n["kind"] != "switch" or not self.desc[n["name"]]["stp"]: continue
            out = nsx(self.ns[n["name"]], "sh", "-c", "cd /sys/class/net/br0 && for f in bridge_id root_id root_port root_path_cost topology_change; do echo $f=$(cat bridge/$f); done; "
                      "for p in brif/*; do for f in port_no port_id state path_cost designated_root designated_bridge designated_port designated_cost; do echo ${p#brif/}/$f=$(cat $p/$f); done; done")
            kv = dict(line.split("=", 1) for line in out.split())
            ports, byno = {}, {}
            for ifn in self.desc[n["name"]]["ports"]:
                g = lambda f: kv[f"{ifn}/{f}"]
                no, pid, state = int(g("port_no"), 16), int(g("port_id"), 16), STATES[int(g("state"))]
                byno[no] = ifn
                desig = g("designated_bridge") == kv["bridge_id"] and int(g("designated_port")) == pid
                role = "disabled" if state == "disabled" else "root" if no == int(kv["root_port"]) else "designated" if desig else "blocked"
                ports[ifn] = {"no": no, "id": "0x%04x" % pid, "cost": int(g("path_cost")), "state": state, "role": role,
                              "designatedRoot": g("designated_root"), "designatedBridge": g("designated_bridge"),
                              "designatedPort": "0x%04x" % int(g("designated_port")), "designatedCost": int(g("designated_cost"))}
            rp = int(kv["root_port"])
            rep[n["name"]] = {"bridge": kv["bridge_id"], "root": kv["root_id"], "rootPort": byno.get(rp) if rp else None,
                              "rootCost": int(kv["root_path_cost"]), "topologyChange": kv["topology_change"] == "1", "ports": ports}
        return rep

    def act(self, a):
        if a["do"] == "stp": return self.stp_report()
        if a["do"] == "link":
            node, ifn = a["cable"].split(":"); sh("ip", "-n", self.ns[node], "link", "set", "dev", ifn, "up" if a["up"] else "down"); return {"ok": True}
        if a["do"] == "observe": time.sleep(a["seconds"]); return {}
        probe = [sys.executable, str(HERE.parent / "l3" / "probe.py")]
        if a["do"] == "ping": args = ["ping", a["dst"], str(a.get("ttl", 64)), str(a.get("timeout", 2))]
        elif a["do"] == "traceroute": args = ["traceroute", a["dst"], str(a.get("maxHops", 8))]
        elif a["do"] == "dns": args = ["dns", a["server"], a["name"]]
        elif a["do"] == "udp": args = ["udp", a["dst"], str(a["port"])]
        return json.loads(nsx(self.ns[a["src"]], *probe, *args))

    def close(self):
        for p in self.procs: p.kill()
        for p in self.sniffers.values(): p.kill()
        for ns in self.ns.values(): sh("ip", "netns", "del", ns, check=False)


def vlan_supported():
    try:
        sh("ip", "link", "add", "vtest0", "type", "bridge", "vlan_filtering", "1")
        sh("ip", "link", "add", "vtest1", "type", "veth", "peer", "name", "vtest2")
        sh("ip", "link", "add", "link", "vtest1", "name", "vtest1.5", "type", "vlan", "id", "5")
        return True
    except subprocess.CalledProcessError:
        return False
    finally:
        for d in ("vtest0", "vtest1"): sh("ip", "link", "del", d, check=False)


def kernel_run(name, desc):
    spec = json.loads((HERE / f"{name}.json").read_text()); actions = json.loads((HERE / f"{name}.actions.json").read_text())
    k = KernelL2(spec, desc); out = []
    try:
        for a in actions:
            if "at" in a:
                wait = k.t0 + a["at"] - time.monotonic()
                if wait < -0.05: raise RuntimeError(f"{name}: action at {a['at']}s started {-wait:.2f}s late")
                time.sleep(max(0, wait))
            started = time.monotonic() - k.t0
            if a["do"] in TRAFFIC: k.flush()
            before = k.snapshot(); r = k.act(a); time.sleep(a.get("settle", 1 if a["do"] in TRAFFIC else 0)); after = k.snapshot()
            frames, bpdus, tagged, last, problems = k.diff(before, after)
            if a["do"] == "observe": r = {"last": last}
            out.append({"action": a, "started": round(started, 3), "result": r, "frames": frames, "bpdus": bpdus, "tagged": tagged, "problems": problems})
    finally:
        k.close()
    return out


def inner():
    sh("mount", "-t", "tmpfs", "none", "/run")  # fresh mount namespace: private /run/netns
    descs = json.loads(sys.stdin.read())
    vlan = vlan_supported()
    res = {"vlan": vlan, "runs": {}}
    for name in descs:
        if name in VLAN_SPECS and not vlan: continue
        res["runs"][name] = kernel_run(name, descs[name])
    print(json.dumps(res))


def comparable(r):
    r = {k: v for k, v in r.items() if k != "rtt_ms"}
    if "hops" in r: r["hops"] = [{k: h[k] for k in ("ttl", "from", "kind")} for h in r["hops"]]
    return r


def compare(e, k):
    """Return a dict of differences (empty if engine and Linux agree)."""
    a, d = e["action"], {}
    if k["problems"]: d["harness"] = k["problems"]
    if a["do"] in TRAFFIC:
        if comparable(e["result"]) != comparable(k["result"]): d["result"] = {"engine": comparable(e["result"]), "linux": comparable(k["result"])}
        for what in ("frames", "tagged"):
            keys = sorted(set(e[what]) | set(k[what]))
            x = {key: (e[what].get(key, 0), k[what].get(key, 0)) for key in keys if e[what].get(key, 0) != k[what].get(key, 0)}
            if x: d[what] = x
    elif a["do"] == "stp":
        for sw in sorted(set(e["result"]) | set(k["result"])):
            es, ks = e["result"].get(sw), k["result"].get(sw)
            if es is None or ks is None: d[sw] = {"engine": es, "linux": ks}; continue
            x = {f: (es[f], ks[f]) for f in es if f != "ports" and es[f] != ks.get(f)}
            for port in sorted(set(es["ports"]) | set(ks["ports"])):
                ep, kp = es["ports"].get(port, {}), ks["ports"].get(port, {})
                for f in sorted(set(ep) | set(kp)):
                    if ep.get(f) != kp.get(f): x[f"{port}.{f}"] = (ep.get(f), kp.get(f))
            if x: d[sw] = x   # field: (engine, linux)
    elif a["do"] == "observe":
        keys = sorted(set(e["bpdus"]) | set(k["bpdus"]))
        x = {key: (e["bpdus"].get(key, 0), k["bpdus"].get(key, 0)) for key in keys
             if not e["bpdus"].get(key) or not k["bpdus"].get(key) or abs(e["bpdus"][key] - k["bpdus"][key]) > 1}
        if x: d["bpdus"] = x
        y = {key: {"engine": e["result"]["last"].get(key), "linux": k["result"]["last"].get(key)} for key in keys
             if e["result"]["last"].get(key) != k["result"]["last"].get(key)}
        if y: d["last_bpdu"] = y
    return d


def summarize(a, e):
    r = e["result"]
    if a["do"] in TRAFFIC:
        what = f'{a["do"]} {a["src"]} → {a.get("dst", a.get("server"))}'
        res = ("reached · " if r.get("reached") else "not reached · ") + " → ".join(h["from"] or "*" for h in r["hops"]) if "hops" in r else \
            ("ok" if r.get("ok") else r.get("error", "?")) + (f' from {r["from"]}' if r.get("from") else "")
        n = f'{sum(e["frames"].values())} frames on {len(e["frames"])} cable directions' + (f', {sum(e["tagged"].values())} tagged' if e["tagged"] else "")
        return what, res, n
    if a["do"] == "stp":
        roots = {v["root"] for v in r.values()}
        blocked = [f"{sw}:{p}" for sw, v in r.items() for p, q in v["ports"].items() if q["role"] == "blocked"]
        moving = [f"{sw}:{p} {q['state']}" for sw, v in r.items() for p, q in v["ports"].items() if q["state"] in ("listening", "learning")]
        res = f'root {", ".join(sorted(roots))}; blocked: {", ".join(blocked) or "none"}' + (f'; {", ".join(moving)}' if moving else "")
        return "spanning-tree state", res, f"{sum(len(v['ports']) for v in r.values())} ports compared"
    if a["do"] == "observe":
        return f'watch BPDUs for {a["seconds"]}s', f'BPDUs on {len(e["bpdus"])} cable directions', f'{sum(e["bpdus"].values())} BPDUs (count ±1), last one compared field by field'
    if a["do"] == "link":
        return f'{"plug in" if a["up"] else "unplug"} {a["cable"]}', "—", "—"
    return a["do"], "", ""


def main(names):
    if os.geteuid() != 0 or not shutil.which("unshare") or not shutil.which("ip") or not shutil.which("bridge"):
        print("Needs root, `unshare` and iproute2. Skipping."); return 0
    eng, descs = {}, {}
    for name in names:
        spec, acts = str(HERE / f"{name}.json"), str(HERE / f"{name}.actions.json")
        descs[name] = json.loads(sh("node", str(ROOT / "engine" / "tools" / "run_spec.mjs"), "--describe", spec))
        eng[name] = json.loads(sh("node", str(ROOT / "engine" / "tools" / "run_spec.mjs"), spec, acts))
    p = subprocess.run(["unshare", "-n", "-m", sys.executable, __file__, "--inner"], input=json.dumps(descs), capture_output=True, text=True, timeout=1200)
    if p.returncode: print(p.stderr); return 1
    kern = json.loads(p.stdout)
    rows, detail, ok_all, skipped = [], {}, True, []
    for name in names:
        if name not in kern["runs"]:
            skipped.append(name); continue
        for e, k in zip(eng[name], kern["runs"][name]):
            a = e["action"]; d = compare(e, k); ok = not d; ok_all &= ok
            what, res, n = summarize(a, e)
            rows.append((name, f'{a["at"]:g}s' if "at" in a else "", what, res, n, "✓" if ok else "✗"))
            if not ok: detail[f'{name} @{a.get("at", "")}s: {what}'] = d
    md = ["| Network | t | Action | Engine result (same in Linux?) | Compared | Match |", "|---|---|---|---|---|---|"]
    md += ["| " + " | ".join(r) + " |" for r in rows]
    if skipped: md += ["", f"Skipped (this kernel has no 802.1Q VLAN support): {', '.join(skipped)}."]
    if skipped and os.environ.get("REQUIRE_VLAN"): ok_all = False
    if names == SPECS: (HERE / "results.md").write_text("\n".join(md) + "\n")
    (HERE / "mismatches.json").write_text(json.dumps(detail, indent=1))
    print("\n".join(md))
    if detail: print(json.dumps(detail, indent=1)[:6000])
    return 0 if ok_all else 1


if __name__ == "__main__":
    if sys.argv[1:] == ["--inner"]: inner()
    else: sys.exit(main(sys.argv[1:] or SPECS))
