#!/usr/bin/env python3
"""Network address translation: the engine vs Linux netfilter (nftables), frame for frame.

    sudo python3 validate/nat/run_kernel_nat.py        # on a Mac: validate/docker/run.sh nat

Each network is built from namespaces like validate/l3 (it reuses that harness). Every router with a `nat` key gets an
nftables nat table translated from the spec: static entries -> dnat in prerouting (outside interface, outside address) and
snat in postrouting (inside -> outside); overload -> masquerade in postrouting; secondary addresses on the outside interface for the static
outside addresses (so Linux answers ARP for them). The same actions run in the engine (engine/tools/run_spec.mjs); results and the frame count on every cable
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

SPECS = ["nat-lab"]


def names(xs):
    return "{ " + ", ".join(f'"{x}"' for x in xs) + " }"


def ruleset(nat):
    """nft translation of a spec's nat key: dnat in prerouting, snat/masquerade in postrouting (forwarded packets only)."""
    if not nat["inside"] or not nat["outside"]: return ""
    ins, outs = names(nat["inside"]), names(nat["outside"])
    pre, post = [], []
    for s in nat.get("static", []):
        if "proto" in s:
            pre.append(f'iifname {outs} ip daddr {s["outside"]} {s["proto"]} dport {s["outsidePort"]} dnat to {s["inside"]}:{s["insidePort"]}')
        else:
            pre.append(f'iifname {outs} ip daddr {s["outside"]} dnat to {s["inside"]}')
            post.append(f'iifname {ins} oifname {outs} ip saddr {s["inside"]} snat to {s["outside"]}')
    ov = nat.get("overload")
    if ov:
        src = ov.get("src") if isinstance(ov, dict) else None
        post.append(f'iifname {ins} oifname {outs} ' + (f'ip saddr {src} ' if src and src != "any" else "") + "masquerade")
    lines = ["table ip opr_nat {", "  chain pre { type nat hook prerouting priority -100; policy accept;"]
    lines += [f"    {x}" for x in pre] + ["  }", "  chain post { type nat hook postrouting priority 100; policy accept;"]
    lines += [f"    {x}" for x in post] + ["  }", "}"]
    return "\n".join(lines) + "\n"


class NatNet(tcpv.TcpNet):
    def __init__(self, spec):
        super().__init__(spec)
        for n in spec["nodes"]:
            if n.get("nat") and ruleset(n["nat"]):
                ns = self.ns[n["name"]]
                subprocess.run(["ip", "netns", "exec", ns, "nft", "-f", "-"], input=ruleset(n["nat"]), text=True, check=True)
                own = set(i.split("/")[0] for i in n["ifaces"].values())
                # The engine answers ARP for static outside addresses (as Cisco does). On Linux that takes a secondary address on the
                # outside interface (`ip neigh add proxy` is not enough: the kernel only proxies for addresses it would route elsewhere).
                oif = n["nat"]["outside"][0]; plen = n["ifaces"][oif].split("/")[1]
                for ip in sorted({s["outside"] for s in n["nat"].get("static", [])} - own):
                    subprocess.run(["ip", "netns", "exec", ns, "ip", "addr", "add", f"{ip}/{plen}", "dev", oif], check=True)
        time.sleep(0.2)


def kernel_run(name):
    spec = json.loads((HERE / f"{name}.json").read_text()); actions = json.loads((HERE / f"{name}.actions.json").read_text())
    k = NatNet(spec); out = []
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
        print("Needs root, unshare, iproute2 and nftables.")
        if os.environ.get("GITHUB_ACTIONS"): print("This check is required in CI: failing instead of skipping."); return 1   # run.sh passes GITHUB_ACTIONS into the container
        print("Skipping."); return 0
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
    if detail: print(json.dumps(detail, indent=1)[:5000]); l3.gh_note("error", "NAT engine vs Linux mismatch", json.dumps(detail))
    return 0 if not detail else 1


if __name__ == "__main__":
    if sys.argv[1:] == ["--inner"]: inner()
    else: sys.exit(main())
