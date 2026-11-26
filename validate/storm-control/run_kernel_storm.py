#!/usr/bin/env python3
"""Storm control: the engine's broadcast policer vs Linux `tc ... action police` on bridge ports, frame for frame.

    sudo python3 validate/storm-control/run_kernel_storm.py      # on a Mac: inside a privileged Linux container

For each limited port the harness puts an ingress qdisc and a flower filter on the bridge port:

    tc filter add dev p1 ingress protocol all prio 1 flower dst_mac ff:ff:ff:ff:ff:ff action police rate R burst B conform-exceed drop

(tc ingress runs before the bridge sees the frame.) Broadcast bursts from the hosts, pings and waits are the steps; compared:
every result, the frames sent on every cable direction, and the frames each policer dropped (the action's own drop counter).
Linux counts a policed frame without its 14-byte Ethernet header at ingress; the engine's Police does the same. Only
broadcast is validated: the engine's hosts do not originate multicast traffic that could be policed.
"""
import json, os, shutil, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "validate" / "l3"))
import run_kernel_l3 as l3  # noqa: E402

SPECS = ["storm"]


def find_drops(o):
    """The `drops` counter of the police action(s) anywhere in a tc JSON document."""
    if isinstance(o, dict):
        if o.get("kind") == "police": return o.get("stats", {}).get("drops", 0)
        return sum(find_drops(v) for v in o.values())
    if isinstance(o, list): return sum(find_drops(v) for v in o)
    return 0


class StormNet(l3.KernelNet):
    def __init__(self, spec):
        super().__init__(spec)
        self.policed = []
        for n in spec["nodes"]:
            for port, c in (n.get("stormControl") or {}).items():
                b = c["broadcast"]; ns = self.ns[n["name"]]
                l3.sh("tc", "-n", ns, "qdisc", "add", "dev", port, "ingress")
                l3.sh("tc", "-n", ns, "filter", "add", "dev", port, "ingress", "protocol", "all", "prio", "1", "flower", "dst_mac", "ff:ff:ff:ff:ff:ff",
                      "action", "police", "rate", str(b["rate"]), "burst", str(b["burst"]), "conform-exceed", "drop")
                self.policed.append((n["name"], port))

    def drops(self):
        return {f"{n}:{p}": find_drops(json.loads(l3.sh("tc", "-n", self.ns[n], "-s", "-j", "filter", "show", "dev", p, "ingress"))) for n, p in self.policed}

    def act(self, a):
        if a["do"] == "udpBurst":
            return json.loads(l3.nsx(self.ns[a["src"]], sys.executable, str(HERE / "bcast.py"), a["dst"], str(a["port"]), str(a["count"]), str(a["size"])))
        return super().act(a)


def kernel_run(name):
    spec = json.loads((HERE / f"{name}.json").read_text()); actions = json.loads((HERE / f"{name}.actions.json").read_text())
    k = StormNet(spec); out = []
    try:
        time.sleep(1)   # every bucket starts full
        for a in actions:
            if a["do"] == "wait": time.sleep(a["seconds"]); out.append({"action": a}); continue
            k.flush(); before, dbefore = k.counters(), k.drops()
            r = k.act(a); time.sleep(a.get("settle", 1)); after, dafter = k.counters(), k.drops()
            out.append({"action": a, "result": r,
                        "frames": {key: after[key] - before.get(key, 0) for key in after if after[key] - before.get(key, 0)},
                        "drops": {key: dafter[key] - dbefore.get(key, 0) for key in dafter if dafter[key] - dbefore.get(key, 0)}})
    finally:
        k.close()
    return out


def inner():
    l3.sh("mount", "-t", "tmpfs", "none", "/run")
    print(json.dumps({name: kernel_run(name) for name in SPECS}))


def main():
    if os.geteuid() != 0 or not shutil.which("unshare") or not shutil.which("ip") or not shutil.which("tc"):
        print("Needs root, `unshare`, iproute2 and `tc`."); return 1 if os.environ.get("GITHUB_ACTIONS") else 0   # in CI a missing tool is an error, not a skip
    proc = subprocess.run(["unshare", "-n", "-m", sys.executable, __file__, "--inner"], capture_output=True, text=True, timeout=600)
    if proc.returncode:
        print("kernel side failed:\n" + proc.stderr[-3000:]); l3.gh_note("error", "Storm control kernel side failed", proc.stderr[-6000:]); return 1
    kern = json.loads(proc.stdout)
    rows, detail = [], {}
    for name in SPECS:
        eng = json.loads(l3.sh("node", str(ROOT / "engine" / "tools" / "run_spec.mjs"), str(HERE / f"{name}.json"), str(HERE / f"{name}.actions.json")))
        for e, k in zip(eng, kern[name]):
            a = e["action"]
            if a["do"] == "wait": continue
            same = l3.comparable(e["result"]) == l3.comparable(k["result"])
            keys = sorted(set(e["frames"]) | set(k["frames"]))
            fd = {key: (e["frames"].get(key, 0), k["frames"].get(key, 0)) for key in keys if e["frames"].get(key, 0) != k["frames"].get(key, 0)}
            ed, kd = e.get("drops", {}), k["drops"]
            dd = {key: (ed.get(key, 0), kd.get(key, 0)) for key in sorted(set(ed) | set(kd)) if ed.get(key, 0) != kd.get(key, 0)}
            ok = same and not fd and not dd
            what = f'{a["do"]} {a["src"]} → {a["dst"]}' + (f' ×{a["count"]} of {a["size"]} B' if "count" in a else "")
            rows.append((name, what, f'{sum(e["frames"].values())} frames on {len(e["frames"])} cable directions', ", ".join(f"{k_} {v}" for k_, v in ed.items()) or "none", "✓" if ok else "✗"))
            if not ok: detail[f"{name}: {what}"] = {"engine": e["result"], "kernel": k["result"], "frame_diffs": fd, "drop_diffs": dd}
        if len([x for x in eng if x["action"]["do"] != "wait"]) != len([x for x in kern[name] if x["action"]["do"] != "wait"]): detail[f"{name}: step count"] = "differs"
    md = ["| Network | Action | Frames (engine = Linux, cable by cable?) | Policer drops (engine = Linux?) | Match |", "|---|---|---|---|---|"]
    md += [f"| {a} | {b} | {c} | {d} | {e} |" for a, b, c, d, e in rows]
    (HERE / "results.md").write_text("\n".join(md) + "\n"); (HERE / "mismatches.json").write_text(json.dumps(detail, indent=1))
    print("\n".join(md)); l3.gh_note("notice", "Storm control results", "\n".join(md))
    if detail: print(json.dumps(detail, indent=1)[:4000]); l3.gh_note("error", "Storm control engine vs Linux mismatch", json.dumps(detail))
    return 0 if not detail else 1


if __name__ == "__main__":
    if sys.argv[1:] == ["--inner"]: inner()
    else: sys.exit(main())
