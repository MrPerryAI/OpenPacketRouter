#!/usr/bin/env python3
"""IPv6 basics: the engine vs Linux, frame for frame (addresses, neighbor discovery, ICMPv6 echo, static routes).

    sudo python3 validate/ipv6/run_kernel_ipv6.py        # on a Mac: validate/docker/run.sh ipv6

The network is built from namespaces like validate/l3 (it reuses that harness with IPv6 left on for hosts and routers, off for
switches). Linux settings that change which frames appear are pinned to what the engine models: duplicate address detection
off (addresses are added with nodad), no router solicitations or advertisements, ICMP rate limit off, and an nftables rule
that drops the link's own chatter on output (MLD reports, router solicitations, DAD probes from ::) so only neighbor
discovery and the echo traffic are counted. Hosts and routers use global addresses and static routes via global addresses
(link-local addresses are not modelled).
"""
import json, os, shutil, struct, subprocess, sys, tempfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "validate" / "l3"))
import run_kernel_l3 as l3  # noqa: E402

SPECS = ["ipv6-lab"]
CHATTER = """table ip6 opr_quiet {
  chain out { type filter hook output priority 0; policy accept;
    ip6 saddr :: drop
    icmpv6 type { nd-router-solicit, mld-listener-report, mld2-listener-report, mld-listener-done } drop
  }
}
"""


class Net6(l3.KernelNet):
    def __init__(self, spec):
        keep = l3.no_ipv6
        l3.no_ipv6 = lambda ns=None, iface=None: None     # leave IPv6 on; the switches are quieted below
        try:
            super().__init__(spec)
        finally:
            l3.no_ipv6 = keep
        for n in spec["nodes"]:
            ns = self.ns[n["name"]]
            if n["kind"] == "switch":
                l3.nsx(ns, "sysctl", "-qw", "net.ipv6.conf.all.disable_ipv6=1", "net.ipv6.conf.default.disable_ipv6=1")
                continue
            for k, v in [("net.ipv6.conf.all.accept_dad", 0), ("net.ipv6.conf.default.accept_dad", 0), ("net.ipv6.conf.all.router_solicitations", 0),
                         ("net.ipv6.conf.default.router_solicitations", 0), ("net.ipv6.conf.all.accept_ra", 0), ("net.ipv6.conf.default.accept_ra", 0),
                         ("net.ipv6.conf.all.accept_redirects", 0), ("net.ipv6.icmp.ratelimit", 0),
                         ("net.ipv6.conf.all.forwarding", 1 if n["kind"] == "router" else 0)]:
                l3.sysctl(ns, k, v)
            subprocess.run(["ip", "netns", "exec", ns, "nft", "-f", "-"], input=CHATTER, text=True, check=True)
            for ifn, cidr in (n.get("ifaces6") or {}).items(): l3.sh("ip", "-n", ns, "-6", "addr", "add", cidr, "dev", ifn, "nodad")
            for dst, via in n.get("routes6", []): l3.sh("ip", "-n", ns, "-6", "route", "add", dst, "via", via)
            if n.get("gw6"): l3.sh("ip", "-n", ns, "-6", "route", "add", "default", "via", n["gw6"])
        # tcpdump on every cable end, outgoing frames only: the ICMPv6 message type of each one, so a wrong solicitation or advertisement shows up
        self.tmp = tempfile.mkdtemp(); self.caps = []; self.seen = {}
        for (node, ifn), peer in self.ifmap.items():
            f = f"{self.tmp}/{node}-{ifn}.pcap"
            p = subprocess.Popen(["ip", "netns", "exec", self.ns[node], "tcpdump", "-i", ifn, "-Q", "out", "-U", "-n", "-s", "0", "-Z", "root", "-w", f, "icmp6"],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.procs.append(p); self.caps.append((f"{node}:{ifn}>{peer}", f))
        time.sleep(3)   # let the interfaces' start-up chatter (MLD, DAD) pass before the first measurement
        self.types()    # remember how much each capture holds now: only later packets belong to an action

    def types(self):
        """ICMPv6 types sent per cable direction since the last call, sorted (read from the pcap files)."""
        out = {}
        for key, f in self.caps:
            try: data = open(f, "rb").read()
            except OSError: continue
            if len(data) < 24: continue
            end = "<" if data[:4] == b"\xd4\xc3\xb2\xa1" else ">"
            pos = 24; n = 0
            while pos + 16 <= len(data):
                incl = struct.unpack(end + "I", data[pos + 8:pos + 12])[0]
                if pos + 16 + incl > len(data): break
                pkt = data[pos + 16:pos + 16 + incl]; pos += 16 + incl; n += 1
                if n <= self.seen.get(key, 0): continue
                if len(pkt) > 54 and pkt[12:14] == b"\x86\xdd" and pkt[20] == 58: out.setdefault(key, []).append(pkt[54])
            self.seen[key] = n
        return {k: sorted(v) for k, v in out.items()}

    def flush(self):
        super().flush()
        for n in self.spec["nodes"]:
            if n["kind"] != "switch": l3.nsx(self.ns[n["name"]], "ip", "-6", "neigh", "flush", "all", check=False)

    def act(self, a):
        ns = self.ns[a["src"]]
        return json.loads(l3.nsx(ns, sys.executable, str(HERE / "probe6.py"), "ping", a["dst"], str(a.get("ttl", 64)), str(a.get("timeout", 2))))


def kernel_run(name):
    spec = json.loads((HERE / f"{name}.json").read_text()); actions = json.loads((HERE / f"{name}.actions.json").read_text())
    k = Net6(spec); out = []
    try:
        for a in actions:
            k.flush(); k.types(); before = k.counters(); r = k.act(a); time.sleep(a.get("settle", 1)); after = k.counters(); time.sleep(0.3)
            out.append({"action": a, "result": r, "frames": {key: after[key] - before.get(key, 0) for key in after if after[key] - before.get(key, 0)}, "icmp6": k.types()})
    finally:
        k.close()
    return out


def inner():
    l3.sh("mount", "-t", "tmpfs", "none", "/run")
    print(json.dumps({name: kernel_run(name) for name in SPECS}))


def comparable(r): return {k: v for k, v in r.items() if k != "rtt_ms"}


def main():
    if os.geteuid() != 0 or not all(shutil.which(x) for x in ("unshare", "ip", "nft")):
        print("Needs root, unshare, iproute2 and nftables.")
        if os.environ.get("GITHUB_ACTIONS"): print("This check is required in CI: failing instead of skipping."); return 1
        print("Skipping."); return 0
    kern = json.loads(subprocess.run(["unshare", "-n", "-m", sys.executable, __file__, "--inner"], check=True, capture_output=True, text=True, timeout=900).stdout)
    rows, detail = [], {}
    for name in SPECS:
        eng = json.loads(l3.sh("node", str(ROOT / "engine" / "tools" / "run_spec.mjs"), str(HERE / f"{name}.json"), str(HERE / f"{name}.actions.json")))
        for e, k in zip(eng, kern[name]):
            a = e["action"]; same = comparable(e["result"]) == comparable(k["result"])
            keys = sorted(set(e["frames"]) | set(k["frames"]))
            diffs = {key: (e["frames"].get(key, 0), k["frames"].get(key, 0)) for key in keys if e["frames"].get(key, 0) != k["frames"].get(key, 0)}
            tkeys = sorted(set(e["icmp6"]) | set(k["icmp6"]))
            tdiffs = {key: (e["icmp6"].get(key, []), k["icmp6"].get(key, [])) for key in tkeys if e["icmp6"].get(key, []) != k["icmp6"].get(key, [])}
            ok = same and not diffs and not tdiffs
            res = e["result"]
            summary = ("ok" if res.get("ok") else res.get("error", "?")) + (f' from {res["from"]}' if res.get("from") else "")
            ttl = f' (hop limit {a["ttl"]})' if "ttl" in a else ""
            rows.append((name, f'ping {a["src"]} → {a["dst"]}{ttl}', summary, f'{sum(e["frames"].values())} frames on {len(e["frames"])} cable directions, types checked', "✓" if ok else "✗"))
            if not ok: detail[f'{name}: ping {a["src"]} → {a["dst"]}{ttl}'] = {"engine": comparable(e["result"]), "linux": comparable(k["result"]), "frame_diffs": diffs, "icmp6_type_diffs (engine, linux)": tdiffs}
    md = ["| Network | Action | Engine result (same in Linux?) | Frames and ICMPv6 types (engine = Linux, cable by cable?) | Match |", "|---|---|---|---|---|"]
    md += [f"| {a} | {b} | {c} | {d} | {e} |" for a, b, c, d, e in rows]
    (HERE / "results.md").write_text("\n".join(md) + "\n"); (HERE / "mismatches.json").write_text(json.dumps(detail, indent=1))
    print("\n".join(md))
    l3.gh_note("notice", "IPv6 results.md", "\n".join(md)); l3.gh_note("notice", "IPv6 mismatches.json", json.dumps(detail))
    if detail: print(json.dumps(detail, indent=1)[:5000]); l3.gh_note("error", "IPv6 engine vs Linux mismatch", json.dumps(detail))
    return 0 if not detail else 1


if __name__ == "__main__":
    if sys.argv[1:] == ["--inner"]: inner()
    else: sys.exit(main())
