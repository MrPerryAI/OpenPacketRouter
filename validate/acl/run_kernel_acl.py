#!/usr/bin/env python3
"""IPv4 access lists: the engine vs Linux netfilter (nftables), frame for frame.

    sudo python3 validate/acl/run_kernel_acl.py        # on a Mac: validate/docker/run.sh acl

Each network is built from namespaces like validate/l3 (it reuses that harness). Every router with an `acl` key
gets an nftables table translated from the spec:
  in  lists  -> a prerouting chain (rules matched on `iifname`), where the engine drops packets before routing;
  out lists  -> the forward chain (rules matched on `oifname`), where it drops packets after the route lookup.
permit -> accept, deny and the implicit deny at the end of every bound list -> `reject with icmp type
admin-prohibited`. Multicast and the limited broadcast are accepted first (the engine never filters them).
The same actions run in the engine (engine/tools/run_spec.mjs); results and the frame count on every cable
direction are compared.
"""
import json, os, shutil, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "validate" / "l3"))
import run_kernel_l3 as l3  # noqa: E402
sys.path.insert(0, str(ROOT / "validate" / "tcp"))
import run_kernel_tcp as tcpv  # noqa: E402

SPECS = ["acl-lab"]
REJECT = "reject with icmp type admin-prohibited"


def match(r):
    """nft match expression for one rule."""
    out, proto = [], r.get("proto", "ip")
    for key, word in (("src", "saddr"), ("dst", "daddr")):
        if r.get(key) not in (None, "any"): out.append(f"ip {word} {r[key]}")
    if proto in ("tcp", "udp"):
        for key in ("sport", "dport"):
            if key in r: out.append(f"{proto} {key} {r[key]}")
        if not any(w.startswith(proto) for w in out): out.insert(0, f"meta l4proto {proto}")
        if r.get("established"): out.append("tcp flags & (ack | rst) != 0")
    elif proto == "icmp":
        out.insert(0, f"icmp type {r['icmpType']}" if "icmpType" in r else "meta l4proto icmp")
    return " ".join(out)


def ruleset(acl):
    pre, fwd = [], []
    for ifn, b in acl.get("bind", {}).items():
        for d, chain, sel in (("in", pre, "iifname"), ("out", fwd, "oifname")):
            if d not in b: continue
            for r in acl["lists"][b[d]]:
                chain.append(f'{sel} "{ifn}" {match(r)} {"accept" if r["action"] == "permit" else REJECT}')
            chain.append(f'{sel} "{ifn}" {REJECT}')
    lines = ["table ip opr_acl {", "  chain acl_in { type filter hook prerouting priority -150; policy accept;",
             "    ip daddr 224.0.0.0/4 accept", "    ip daddr 255.255.255.255 accept"]
    lines += [f"    {x}" for x in pre] + ["  }", "  chain acl_out { type filter hook forward priority 0; policy accept;"]
    lines += [f"    {x}" for x in fwd] + ["  }", "}"]
    return "\n".join(lines) + "\n"


class AclNet(tcpv.TcpNet):
    def __init__(self, spec):
        super().__init__(spec)
        for n in spec["nodes"]:
            if n.get("acl"):
                subprocess.run(["ip", "netns", "exec", self.ns[n["name"]], "nft", "-f", "-"], input=ruleset(n["acl"]), text=True, check=True)


def kernel_run(name):
    spec = json.loads((HERE / f"{name}.json").read_text()); actions = json.loads((HERE / f"{name}.actions.json").read_text())
    k = AclNet(spec); out = []
    try:
        for a in actions:
            k.flush(); before = k.counters(); r = k.act(a); time.sleep(a.get("settle", 1)); after = k.counters()
            out.append({"action": a, "result": r, "frames": {key: after[key] - before.get(key, 0) for key in after if after[key] - before.get(key, 0)}})
    finally:
        k.close()
    return out


def inner():
    l3.sh("mount", "-t", "tmpfs", "none", "/run")
    print(json.dumps({name: kernel_run(name) for name in SPECS}))


comparable = tcpv.comparable


def main():
    if os.geteuid() != 0 or not all(shutil.which(x) for x in ("unshare", "ip", "nft")):
        print("Needs root, unshare, iproute2 and nftables. Skipping."); return 0
    kern = json.loads(subprocess.run(["unshare", "-n", "-m", sys.executable, __file__, "--inner"], check=True, capture_output=True, text=True, timeout=600).stdout)
    rows, detail = [], {}
    for name in SPECS:
        eng = json.loads(l3.sh("node", str(ROOT / "engine" / "tools" / "run_spec.mjs"), str(HERE / f"{name}.json"), str(HERE / f"{name}.actions.json")))
        for e, k in zip(eng, kern[name]):
            a = e["action"]; same = comparable(e["result"]) == comparable(k["result"])
            keys = sorted(set(e["frames"]) | set(k["frames"]))
            diffs = {key: (e["frames"].get(key, 0), k["frames"].get(key, 0)) for key in keys if e["frames"].get(key, 0) != k["frames"].get(key, 0)}
            ok = same and not diffs
            what = f'{a["do"]} {a["src"]} → {a.get("dst", a.get("server"))}' + (f' ({a["name"]})' if "name" in a else "") + (f' port {a["port"]}' if "port" in a else "")
            res = e["result"]
            summary = ("reached" if res.get("reached") else "not reached") + " · " + " → ".join(h["from"] or "*" for h in res["hops"]) if "hops" in res else \
                ("ok" if res.get("ok") else res.get("error", "?")) + (f' from {res["from"]}' if res.get("from") else "")
            rows.append((name, what, summary, f'{sum(e["frames"].values())} frames on {len(e["frames"])} cable directions', "✓" if ok else "✗"))
            if not ok: detail[f"{name}: {what}"] = {"engine": comparable(e["result"]), "linux": comparable(k["result"]), "frame_diffs": diffs}
    md = ["| Network | Action | Engine result (same in Linux?) | Frames (engine = Linux, cable by cable?) | Match |", "|---|---|---|---|---|"]
    md += [f"| {a} | {b} | {c} | {d} | {e} |" for a, b, c, d, e in rows]
    (HERE / "results.md").write_text("\n".join(md) + "\n"); (HERE / "mismatches.json").write_text(json.dumps(detail, indent=1))
    print("\n".join(md))
    if detail: print(json.dumps(detail, indent=1)[:5000]); l3.gh_note("error", "ACL engine vs Linux mismatch", json.dumps(detail))
    return 0 if not detail else 1


if __name__ == "__main__":
    if sys.argv[1:] == ["--inner"]: inner()
    else: sys.exit(main())
