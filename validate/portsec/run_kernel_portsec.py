#!/usr/bin/env python3
"""Port security: the engine vs Linux (nftables in the bridge family), frame for frame.

    sudo python3 validate/portsec/run_kernel_portsec.py        (inside a privileged Linux container on a Mac)

Linux bridges have no "maximum MACs per port" setting, so the reference is the netfilter mechanism that does the job:
for each limited port, a dynamic nftables set of source MACs with `size N`, in a bridge-family prerouting chain (this
hook runs before the bridge learns a source address):

    iifname "p1" ether saddr @s_p1 accept                    # a secured address
    iifname "p1" add @s_p1 { ether saddr } accept            # a new one, while the set has room (the add fails, and the rule is skipped, when the set is full)
    iifname "p1" counter name v_p1 drop                      # everything else: a violation

The same steps (portsec.steps.json) run on the engine and on kernel bridges in namespaces: pings (frames per cable
direction) and, after each group, which hosts' addresses each limited port secured and how many frames it dropped
(the nft counter). All of it must match. The `shutdown` violation action has no netfilter equivalent (a rule cannot
take a port down), so it is covered by the engine's own tests only.
"""
import json, os, shutil, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "validate" / "l3")); sys.path.insert(0, str(ROOT / "validate" / "l2"))
from run_kernel_l3 import sh, nsx  # noqa: E402
import run_kernel_l3 as l3  # noqa: E402
from run_kernel_l2 import Net  # noqa: E402

NAME, STEPS = "portsec", "portsec.steps"


def ruleset(ports):
    out = ["table bridge portsec {"]
    for p, c in ports.items(): out += [f"  set s_{p} {{ type ether_addr; size {c['max']}; flags dynamic; }}", f"  counter v_{p} {{ }}"]
    out += ["  chain pre { type filter hook prerouting priority -300; policy accept;"]
    for p in ports:
        out += [f'    iifname "{p}" ether saddr @s_{p} accept', f'    iifname "{p}" add @s_{p} {{ ether saddr }} accept', f'    iifname "{p}" counter name "v_{p}" drop']
    return "\n".join(out + ["  }", "}"]) + "\n"


def elems(js, kind):
    for o in json.loads(js)["nftables"]:
        if kind in o: return o[kind]
    return {}


def kernel():
    spec = json.loads((HERE / f"{NAME}.json").read_text()); steps = json.loads((HERE / f"{STEPS}.json").read_text())
    Net.DEFER_UP = False
    k = Net(spec); out = []
    try:
        owner = {}
        for n in spec["nodes"]:
            for l in json.loads(sh("ip", "-n", k.ns[n["name"]], "-j", "link", "show")):
                if l["ifname"] != "lo":
                    owner[l["address"]] = f'{n["name"]}:{l["ifname"]}'
                    nsx(k.ns[n["name"]], "sh", "-c", f"echo 100000 > /proc/sys/net/ipv4/neigh/{l['ifname']}/delay_first_probe_time")
        for n in spec["nodes"]:
            if n.get("portSecurity"):
                subprocess.run(["ip", "netns", "exec", k.ns[n["name"]], "nft", "-f", "-"], input=ruleset(n["portSecurity"]), text=True, check=True)
        time.sleep(1.0)
        for s in steps:
            if s.get("flush"): k.flush()
            elif "ping" in s:
                before = k.counters(); r = k.ping(*s["ping"]); time.sleep(1); after = k.counters()
                out.append({"ping": s["ping"], "ok": bool(r.get("ok")), "frames": {x: after[x] - before.get(x, 0) for x in after if after[x] - before.get(x, 0)}})
            elif "portsec" in s:
                sw = s["portsec"]; ns = k.ns[sw]; ports = {}
                for p in k.node[sw]["portSecurity"]:
                    st = json.loads(nsx(ns, "nft", "-j", "list", "set", "bridge", "portsec", f"s_{p}"))
                    el = elems(json.dumps(st), "set").get("elem", [])
                    macs = [e["elem"]["val"] if isinstance(e, dict) else e for e in el]
                    c = elems(nsx(ns, "nft", "-j", "list", "counter", "bridge", "portsec", f"v_{p}"), "counter")
                    ports[p] = {"secured": sorted(owner[m] for m in macs), "violations": c["packets"]}
                out.append({"portsec": sw, "ports": ports})
    finally:
        k.close()
    return out


def inner():
    sh("mount", "-t", "tmpfs", "none", "/run")
    print(json.dumps(kernel()))


def main():
    if os.geteuid() != 0 or not all(shutil.which(x) for x in ("unshare", "ip", "bridge", "nft")):
        print("Needs root, `unshare`, iproute2 (ip, bridge) and nftables."); return 1 if os.environ.get("GITHUB_ACTIONS") else 0   # in CI a missing tool is an error, not a skip
    proc = subprocess.run(["unshare", "-n", "-m", sys.executable, __file__, "--inner"], capture_output=True, text=True, timeout=900)
    if proc.returncode:
        print("kernel side failed:\n" + proc.stderr[-3000:]); l3.gh_note("error", "Port security kernel side failed", proc.stderr[-6000:]); return 1
    kern = json.loads(proc.stdout)
    eng = json.loads(sh("node", str(ROOT / "engine/tools/run_portsec.mjs"), str(HERE / f"{NAME}.json"), str(HERE / f"{STEPS}.json")))
    md = ["| Step | Result | Match |", "|---|---|---|"]; ok_all = True; detail = {}
    for i, (e, k) in enumerate(zip(eng, kern)):
        ok = e == k; ok_all &= ok
        if "ping" in e: label = f'ping {e["ping"][0]} → {e["ping"][1]}'; res = ("ok" if e["ok"] else "no reply") + f' · {sum(e["frames"].values())} frames on {len(e["frames"])} cable directions'
        else: label = f'secured addresses on {e["portsec"]}'; res = " · ".join(f'{p}: {",".join(v["secured"]) or "none"}, {v["violations"]} dropped' for p, v in e["ports"].items())
        md.append(f'| {i + 1}. {label} | {res} | {"✓" if ok else "✗"} |')
        if not ok: detail[f"step {i + 1}: {label}"] = {"engine": e, "kernel": k}
    if len(eng) != len(kern): ok_all = False; detail["step count"] = {"engine": len(eng), "kernel": len(kern)}
    (HERE / "results.md").write_text("\n".join(md) + "\n"); (HERE / "mismatches.json").write_text(json.dumps(detail, indent=1))
    print("\n".join(md)); l3.gh_note("notice", "Port security results", "\n".join(md))
    if detail: print(json.dumps(detail, indent=1)[:6000]); l3.gh_note("error", "Port security engine vs Linux mismatch", json.dumps(detail))
    return 0 if ok_all else 1


if __name__ == "__main__":
    if sys.argv[1:] == ["--inner"]: inner()
    else: sys.exit(main())
