#!/usr/bin/env python3
"""Inter-VLAN routing: the engine vs real Linux, frame for frame.

    sudo python3 validate/intervlan/run_kernel_intervlan.py     # on a Mac: validate/docker/run.sh intervlan

roas (router on a stick): the router's "eth0.10"/"eth0.20" are Linux 802.1Q subinterfaces
(`ip link add link eth0 name eth0.10 type vlan id 10`) on one trunk cable; its untagged eth0 is
on the trunk's native VLAN.
svi (Layer 3 switch): the switch is a vlan_filtering bridge whose "vlan10"/"vlan20"/"vlan30" are
vlan devices on br0 itself (`bridge vlan add dev br0 vid 10 self`; `ip link add link br0 name
vlan10 type vlan id 10`), with ip_forward on, so the switch routes between its VLANs.

Each network is built from namespaces, veth pairs and kernel bridges (validate/l2's Net), the
same actions as the engine run with ARP caches and MAC tables flushed before each, and the
results and the frame count on every cable direction are compared.
"""
import json, os, shutil, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "validate" / "l3")); sys.path.insert(0, str(ROOT / "validate" / "l2"))
from run_kernel_l3 import sh, nsx, comparable  # noqa: E402
from run_kernel_l2 import Net  # noqa: E402

SPECS = ["roas", "svi"]
PROBE = str(ROOT / "validate" / "l3" / "probe.py")


def act(k, a):
    ns = k.ns[a["src"]]
    if a["do"] == "ping": args = ["ping", a["dst"], str(a.get("ttl", 64)), str(a.get("timeout", 2))]
    elif a["do"] == "traceroute": args = ["traceroute", a["dst"], str(a.get("maxHops", 8))]
    else: raise ValueError(f'unsupported action {a["do"]}')
    return json.loads(nsx(ns, sys.executable, PROBE, *args))


def kernel_run(name):
    spec = json.loads((HERE / f"{name}.json").read_text()); acts = json.loads((HERE / f"{name}.actions.json").read_text())
    k = Net(spec); out = []
    try:
        for a in acts:
            k.flush(); before = k.counters(); r = act(k, a); time.sleep(a.get("settle", 1)); after = k.counters()
            out.append({"action": a, "result": r, "frames": {x: after[x] - before.get(x, 0) for x in after if after[x] - before.get(x, 0)}})
    finally: k.close()
    return out


def inner():
    sh("mount", "-t", "tmpfs", "none", "/run")
    print(json.dumps({name: kernel_run(name) for name in SPECS}))


def summary(res):
    if "hops" in res: return ("reached" if res.get("reached") else "not reached") + " · " + " → ".join(h["from"] or "*" for h in res["hops"])
    return ("ok" if res.get("ok") else res.get("error", "?")) + (f' from {res["from"]}' if res.get("from") else "")


def main():
    if os.geteuid() != 0 or not shutil.which("unshare") or not shutil.which("ip") or not shutil.which("bridge"):
        print("Needs root, `unshare`, iproute2 (ip, bridge). Skipping."); return 0
    proc = subprocess.run(["unshare", "-n", "-m", sys.executable, __file__, "--inner"], capture_output=True, text=True, timeout=900)
    if proc.returncode:
        print("kernel side failed:\n" + proc.stderr[-3000:]); return 1
    kern = json.loads(proc.stdout)
    md = ["| Network | Action | Engine result (same in Linux?) | Frames (engine = Linux, cable by cable?) | Match |", "|---|---|---|---|---|"]
    ok_all = True; detail = {}
    for name in SPECS:
        eng = json.loads(sh("node", str(ROOT / "engine/tools/run_spec.mjs"), str(HERE / f"{name}.json"), str(HERE / f"{name}.actions.json")))
        for e, k in zip(eng, kern[name]):
            a = e["action"]; same = comparable(e["result"]) == comparable(k["result"])
            keys = sorted(set(e["frames"]) | set(k["frames"]))
            diffs = {x: (e["frames"].get(x, 0), k["frames"].get(x, 0)) for x in keys if e["frames"].get(x, 0) != k["frames"].get(x, 0)}
            ok = same and not diffs; ok_all &= ok
            what = f'{a["do"]} {a["src"]} → {a["dst"]}'
            md.append(f'| {name} | {what} | {summary(e["result"])} | {sum(e["frames"].values())} frames on {len(e["frames"])} cable directions | {"✓" if ok else "✗"} |')
            if not ok: detail[f"{name}: {what}"] = {"engine": comparable(e["result"]), "kernel": comparable(k["result"]), "frame_diffs": diffs}
    (HERE / "results.md").write_text("\n".join(md) + "\n"); (HERE / "mismatches.json").write_text(json.dumps(detail, indent=1))
    print("\n".join(md))
    if detail: print(json.dumps(detail, indent=1)[:6000])
    return 0 if ok_all else 1


if __name__ == "__main__":
    if sys.argv[1:] == ["--inner"]: inner()
    else: sys.exit(main())
