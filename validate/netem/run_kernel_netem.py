#!/usr/bin/env python3
"""Link delay and loss: the engine vs Linux `tc netem`, frame for frame.

    sudo python3 validate/netem/run_kernel_netem.py        (inside a privileged Linux container on a Mac)

Builds each spec from namespaces like validate/l3, then puts `tc qdisc add dev IF root netem delay D loss gemodel P R 1-H 1-K` on
every cable end: D is the cable's delay in the spec, and the loss model is the one the spec gives that end (a cable end without a loss
model gets only the delay). Linux's loss is random, except that a Gilbert-Elliott model whose four probabilities are all 0% or
100% is a fixed pattern: the engine accepts exactly those (see LossModel in engine/src/link.js; `P R 1-H 1-K` are toBad, toGood,
inBad, inGood). Compared: each action's result, the frames sent on every cable direction, the frames each end's qdisc dropped
and, for pings, the round trip time to the millisecond (the kernel adds a little processing time, so its RTT is truncated
to whole ms and must equal the engine's; the engine's delays are whole ms).
"""
import json, os, shutil, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "validate" / "l3"))
import run_kernel_l3 as l3  # noqa: E402

SPECS = ["delay", "loss"]


def pct(v): return "100%" if v else "0%"


class NetemNet(l3.KernelNet):
    def __init__(self, spec):
        super().__init__(spec)
        self.ends = []
        for a, b, *rest in spec["links"]:
            delay = rest[0] if rest else 1; opts = rest[1] if len(rest) > 1 else {}
            for ref, key in ((a, "loss"), (b, "lossBack")):
                node, ifn = ref.split(":")
                args = ["delay", f"{delay}ms"]
                if key in opts:
                    m = opts[key]; args += ["loss", "gemodel", pct(m["toBad"]), pct(m["toGood"]), pct(m["inBad"]), pct(m["inGood"])]
                l3.sh("tc", "-n", self.ns[node], "qdisc", "replace", "dev", ifn, "root", "netem", *args)
                self.ends.append((node, ifn))

    def drops(self):
        out = {}
        for node, ifn in self.ends:
            q = json.loads(l3.sh("tc", "-n", self.ns[node], "-s", "-j", "qdisc", "show", "dev", ifn))
            out[f"{node}:{ifn}"] = sum(x.get("drops", 0) for x in q if x.get("kind") == "netem")
        return out

    def act(self, a):
        if a["do"] == "udpBurst":
            return json.loads(l3.nsx(self.ns[a["src"]], sys.executable, str(ROOT / "validate" / "links" / "burst.py"),
                                     a["dst"], str(a["port"]), str(a["count"]), str(a["size"])))
        return super().act(a)


def kernel_run(name):
    spec = json.loads((HERE / f"{name}.json").read_text()); actions = json.loads((HERE / f"{name}.actions.json").read_text())
    k = NetemNet(spec); out = []
    try:
        time.sleep(1)
        for a in actions:
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
    need = ["unshare", "ip", "tc"]
    if os.geteuid() != 0 or not all(shutil.which(x) for x in need):
        print(f"Needs root and {', '.join(need)}."); return 1 if os.environ.get("GITHUB_ACTIONS") else 0   # in CI a missing tool is an error, not a skip
    p = subprocess.run(["unshare", "-n", "-m", sys.executable, __file__, "--inner"], capture_output=True, text=True, timeout=600)
    if p.returncode:
        print("kernel side failed:\n" + p.stderr[-3000:]); l3.gh_note("error", "netem kernel side failed", p.stderr[-6000:]); return 1
    kern = json.loads(p.stdout)
    rows, detail = [], {}
    for name in SPECS:
        eng = json.loads(l3.sh("node", str(ROOT / "engine" / "tools" / "run_spec.mjs"), str(HERE / f"{name}.json"), str(HERE / f"{name}.actions.json")))
        if len(eng) != len(kern[name]): detail[f"{name}: step count"] = {"engine": len(eng), "kernel": len(kern[name])}
        for i, (e, k) in enumerate(zip(eng, kern[name])):
            a = e["action"]
            same = l3.comparable(e["result"]) == l3.comparable(k["result"])
            er, kr = e["result"].get("rtt_ms"), k["result"].get("rtt_ms")
            rtt_ok = er is None or (kr is not None and int(kr) == int(er))
            keys = sorted(set(e["frames"]) | set(k["frames"]))
            fd = {key: (e["frames"].get(key, 0), k["frames"].get(key, 0)) for key in keys if e["frames"].get(key, 0) != k["frames"].get(key, 0)}
            ed, kd = e.get("drops", {}), k["drops"]
            dd = {key: (ed.get(key, 0), kd.get(key, 0)) for key in sorted(set(ed) | set(kd)) if ed.get(key, 0) != kd.get(key, 0)}
            ok = same and rtt_ok and not fd and not dd
            what = f'{a["do"]} {a["src"]} → {a["dst"]}' + (f' ×{a["count"]} of {a["size"]} B' if "count" in a else "")
            res = (f'rtt {er} ms' if er is not None else "no reply" if e["result"].get("ok") is False else f'{e["result"].get("sent")} sent')
            drops = ", ".join(f"{k_} {v}" for k_, v in ed.items()) or "none"
            rows.append((name, what, res, f'{sum(e["frames"].values())} frames on {len(e["frames"])} cable directions', drops, "✓" if ok else "✗"))
            if not ok: detail[f"{name} {i + 1}: {what}"] = {"engine": e["result"], "kernel": k["result"], "frame_diffs": fd, "drop_diffs": dd}
    md = ["| Network | Action | Result (engine) | Frames (engine = Linux, cable by cable?) | Netem drops (engine = Linux?) | Match |", "|---|---|---|---|---|---|"]
    md += [f"| {a} | {b} | {c} | {d} | {e} | {f} |" for a, b, c, d, e, f in rows]
    (HERE / "results.md").write_text("\n".join(md) + "\n"); (HERE / "mismatches.json").write_text(json.dumps(detail, indent=1))
    print("\n".join(md)); l3.gh_note("notice", "netem results", "\n".join(md))
    if detail: print(json.dumps(detail, indent=1)[:6000]); l3.gh_note("error", "netem engine vs Linux mismatch", json.dumps(detail))
    return 0 if not detail else 1


if __name__ == "__main__":
    if sys.argv[1:] == ["--inner"]: inner()
    else: sys.exit(main())
