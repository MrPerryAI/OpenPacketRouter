#!/usr/bin/env python3
"""Port mirroring (SPAN): the engine vs Linux `tc ... action mirred`, frame for frame.

    sudo python3 validate/span/run_kernel_span.py        # on a Mac: validate/docker/run.sh span

The switch is a kernel bridge (validate/l2's Net). A monitor session's destination port is taken out of the bridge, and every source
port gets a clsact qdisc with a matchall filter and `action mirred egress mirror dev DEST` on ingress (frames the port receives),
egress (frames it sends) or both. The same pings run in the engine; results and the frame count on every cable direction (including
the monitor cables) are compared.
"""
import json, os, shutil, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "validate" / "l3")); sys.path.insert(0, str(ROOT / "validate" / "l2"))
from run_kernel_l3 import sh, nsx, comparable  # noqa: E402
import run_kernel_l3 as l3  # noqa: E402
from run_kernel_l2 import Net  # noqa: E402

SPECS = ["span-lab"]


class SpanNet(Net):
    def __init__(self, spec):
        super().__init__(spec)
        for n in spec["nodes"]:
            if not n.get("monitor"): continue
            ns = self.ns[n["name"]]
            for s in n["monitor"].values():
                sh("ip", "-n", ns, "link", "set", s["destination"], "nomaster")   # a monitor port is not a bridge port
            hooks = set()
            for s in n["monitor"].values():
                for port, d in s["sources"].items():
                    if port not in hooks:
                        sh("tc", "-n", ns, "qdisc", "add", "dev", port, "clsact") if False else nsx(ns, "tc", "qdisc", "add", "dev", port, "clsact"); hooks.add(port)
                    for hook in ({"rx": ["ingress"], "tx": ["egress"], "both": ["ingress", "egress"]}[d]):
                        nsx(ns, "tc", "filter", "add", "dev", port, hook, "matchall", "action", "mirred", "egress", "mirror", "dev", s["destination"])
        time.sleep(0.3)


def kernel_run(name):
    spec = json.loads((HERE / f"{name}.json").read_text()); acts = json.loads((HERE / f"{name}.actions.json").read_text())
    k = SpanNet(spec); out = []
    try:
        for a in acts:
            k.flush(); before = k.counters(); r = k.ping(a["src"], a["dst"], a.get("timeout", 2)); time.sleep(a.get("settle", 1)); after = k.counters()
            out.append({"action": a, "result": r, "frames": {x: after[x] - before.get(x, 0) for x in after if after[x] - before.get(x, 0)}})
    finally: k.close()
    return out


def inner():
    sh("mount", "-t", "tmpfs", "none", "/run")
    print(json.dumps({n: kernel_run(n) for n in SPECS}))


def main():
    if os.geteuid() != 0 or not shutil.which("unshare") or not shutil.which("tc"):
        print("Needs root, `unshare`, iproute2 (ip, tc). Skipping."); return 0
    proc = subprocess.run(["unshare", "-n", "-m", sys.executable, __file__, "--inner"], capture_output=True, text=True, timeout=900)
    if proc.returncode:
        print("kernel side failed:\n" + proc.stderr[-3000:]); l3.gh_note("error", "SPAN kernel side failed", proc.stderr[-6000:]); return 1
    kern = json.loads(proc.stdout)
    md = ["| Network | Action | Result | Frames (engine = Linux, cable by cable?) | Match |", "|---|---|---|---|---|"]; detail = {}
    for name in SPECS:
        eng = json.loads(sh("node", str(ROOT / "engine/tools/run_spec.mjs"), str(HERE / f"{name}.json"), str(HERE / f"{name}.actions.json")))
        for e, k in zip(eng, kern[name]):
            a = e["action"]; same = comparable(e["result"]) == comparable(k["result"])
            keys = set(e["frames"]) | set(k["frames"]); diffs = {x: (e["frames"].get(x, 0), k["frames"].get(x, 0)) for x in keys if e["frames"].get(x, 0) != k["frames"].get(x, 0)}
            ok = same and not diffs
            mon = sum(v for x, v in e["frames"].items() if x.startswith("SW:p4") or x.startswith("SW:p5"))
            md.append(f'| {name} | ping {a["src"]} → {a["dst"]} | {"ok" if e["result"].get("ok") else "no reply"} | {sum(e["frames"].values())} frames on {len(e["frames"])} cable directions, {mon} copies to monitors | {"✓" if ok else "✗"} |')
            if not ok: detail[f"{name}: {a}"] = {"engine": e, "linux": k, "frame_diffs": diffs}
    (HERE / "results.md").write_text("\n".join(md) + "\n"); (HERE / "mismatches.json").write_text(json.dumps(detail, indent=1))
    print("\n".join(md)); l3.gh_note("notice", "SPAN results.md", "\n".join(md)); l3.gh_note("notice", "SPAN mismatches.json", json.dumps(detail, indent=1))
    if detail: print(json.dumps(detail, indent=1)[:5000]); l3.gh_note("error", "SPAN engine vs Linux mismatch", json.dumps(detail))
    return 0 if not detail else 1


if __name__ == "__main__":
    if sys.argv[1:] == ["--inner"]: inner()
    else: sys.exit(main())
