#!/usr/bin/env python3
"""MAC address aging: the engine vs real Linux kernel bridges (`ageing_time`), frame for frame.

    sudo python3 validate/aging/run_kernel_aging.py        (inside a privileged Linux container on a Mac)

The network (aging.json) has two switches with different aging times. The same steps (aging.steps.json)
run on the engine and on kernel bridges in network namespaces: pings (flooding vs unicast shows in the
per-cable frame counts), real waits, and snapshots of every switch's learned MAC table. All of it must
match exactly. The waits are chosen away from an expiry instant, because the kernel removes expired
entries from a garbage-collection timer, not at the exact instant. The whole run stays under 5 s because
a Linux host re-probes an ARP entry 5 s after first using it (a unicast ARP pair the engine does not model), so the
harness pins delay_first_probe_time high on every interface, like the other pinned settings.
"""
import json, os, shutil, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "validate" / "l3")); sys.path.insert(0, str(ROOT / "validate" / "l2"))
from run_kernel_l3 import sh, nsx  # noqa: E402
import run_kernel_l3 as l3  # noqa: E402
from run_kernel_l2 import Net  # noqa: E402

CASES = [("aging", "aging.steps")]
WATCH = [("SW1", "p3")]


def macs(k):
    """MAC -> "node:iface" for every interface of every node."""
    m = {}
    for n in k.spec["nodes"]:
        ns = k.ns[n["name"]]
        for l in json.loads(sh("ip", "-n", ns, "-j", "link", "show")):
            if l["ifname"] != "lo": m[l["address"]] = f'{n["name"]}:{l["ifname"]}'
    return m


def table(k, sw, owner):
    """Dynamic (learned) entries of a switch: {"vlan|node:iface": port}."""
    out = {}
    for e in json.loads(nsx(k.ns[sw], "bridge", "-j", "fdb", "show", "br", "br0") or "[]"):
        if e.get("state") in ("permanent", "static") or e["mac"] not in owner: continue   # local addresses and group addresses are not learned
        out[f'{e.get("vlan", 0)}|{owner[e["mac"]]}'] = e["ifname"]
    return out


def kernel(name, steps_name):
    spec = json.loads((HERE / f"{name}.json").read_text()); steps = json.loads((HERE / f"{steps_name}.json").read_text())
    k = Net(spec); out = []; sniffers = []
    try:
        owner = macs(k)
        for n in spec["nodes"]:
            for l in json.loads(sh("ip", "-n", k.ns[n["name"]], "-j", "link", "show")):
                if l["ifname"] != "lo": nsx(k.ns[n["name"]], "sh", "-c", f"echo 100000 > /proc/sys/net/ipv4/neigh/{l['ifname']}/delay_first_probe_time")
        time.sleep(1.0)
        for sw, port in WATCH:   # diagnostic only: what the kernel really sent on these cables (shown if a step mismatches)
            f = f"/tmp/aging-{sw}-{port}.txt"; open(f, "w").close()
            sniffers.append(subprocess.Popen(["ip", "netns", "exec", k.ns[sw], sys.executable, str(HERE / "sniff.py"), port, f]))
        time.sleep(0.3)
        for s in steps:
            if s.get("flush"): k.flush()
            elif "wait" in s: time.sleep(s["wait"])
            elif "ping" in s:
                before = k.counters(); r = k.ping(*s["ping"]); time.sleep(s.get("settle", 1)); after = k.counters()
                out.append({"ping": s["ping"], "ok": bool(r.get("ok")), "wire": {f"{sw}:{p}": open(f"/tmp/aging-{sw}-{p}.txt").read().splitlines()[-40:] for sw, p in WATCH}, "frames": {x: after[x] - before.get(x, 0) for x in after if after[x] - before.get(x, 0)}})
            elif "table" in s: out.append({"table": s["table"], "tables": {sw: table(k, sw, owner) for sw in s["table"]}})
    finally:
        for p in sniffers: p.kill()
        k.close()
    return out


def inner():
    sh("mount", "-t", "tmpfs", "none", "/run")
    print(json.dumps({n: kernel(n, st) for n, st in CASES}))


def main():
    if os.geteuid() != 0 or not shutil.which("unshare") or not shutil.which("ip") or not shutil.which("bridge"):
        print("Needs root, `unshare`, iproute2 (ip, bridge). Skipping."); return 0
    proc = subprocess.run(["unshare", "-n", "-m", sys.executable, __file__, "--inner"], capture_output=True, text=True, timeout=900)
    if proc.returncode:
        print("kernel side failed:\n" + proc.stderr[-3000:]); l3.gh_note("error", "Aging kernel side failed", proc.stderr[-6000:]); return 1
    kern = json.loads(proc.stdout)
    md = ["| Network | Step | Result | Match |", "|---|---|---|---|"]; ok_all = True; detail = {}
    for name, steps_name in CASES:
        eng = json.loads(sh("node", str(ROOT / "engine/tools/run_aging.mjs"), str(HERE / f"{name}.json"), str(HERE / f"{steps_name}.json")))
        for i, (e, k) in enumerate(zip(eng, kern[name])):
            wire = k.pop("wire", None); ok = e == k; ok_all &= ok
            if "ping" in e:
                label = f'ping {e["ping"][0]} → {e["ping"][1]}'
                res = f'{"ok" if e["ok"] else "no reply"} · {sum(e["frames"].values())} frames on {len(e["frames"])} cable directions'
            else:
                label = "MAC tables " + ", ".join(e["table"]); res = " · ".join(f'{sw}: {len(t)} entries' for sw, t in e["tables"].items())
            md.append(f'| {name} | {i + 1}. {label} | {res} | {"✓" if ok else "✗"} |')
            if not ok: detail[f"{name} step {i + 1}: {label}"] = {"engine": e, "kernel": k, "kernel_wire": wire}
        if len(eng) != len(kern[name]): ok_all = False; detail[f"{name}: step count"] = {"engine": len(eng), "kernel": len(kern[name])}
    (HERE / "results.md").write_text("\n".join(md) + "\n"); (HERE / "mismatches.json").write_text(json.dumps(detail, indent=1))
    print("\n".join(md))
    if detail: print(json.dumps(detail, indent=1)[:6000]); l3.gh_note("error", "Aging engine vs Linux mismatch", json.dumps(detail))
    return 0 if ok_all else 1


if __name__ == "__main__":
    if sys.argv[1:] == ["--inner"]: inner()
    else: sys.exit(main())
