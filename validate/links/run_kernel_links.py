#!/usr/bin/env python3
"""Link capacity, queues and drops: the engine's token bucket vs Linux's `tbf` qdisc, frame for frame.

    sudo python3 validate/links/run_kernel_links.py      # on a Mac: validate/docker/run.sh links

Builds each spec from network namespaces exactly like validate/l3 (it reuses that harness), then puts
`tc qdisc add dev IF root tbf rate R burst B limit L` on every interface the spec shapes. Each action
starts with cold caches and full token buckets. Compared: the result, the frames sent on every cable
direction, and the frames each shaped interface dropped.
"""
import json, os, shutil, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "validate" / "l3"))
import run_kernel_l3 as l3  # noqa: E402

SPECS = ["tbf-host", "tbf-switch", "tbf-stp-fit", "tbf-stp-drop"]


class ShapedNet(l3.KernelNet):
    def __init__(self, spec):
        super().__init__(spec)
        self.stp_nodes = [n for n in spec["nodes"] if n["kind"] == "switch" and n.get("stp")]
        for n in self.stp_nodes:     # spanning-tree bridges, like validate/l2; the tree itself starts in start_stp()
            l3.sh("ip", "-n", self.ns[n["name"]], "link", "set", "br0", "address", n["stp"]["mac"])
        self.shaped = []
        for a, b, *rest in spec["links"]:
            opts = rest[1] if len(rest) > 1 else {}
            for ref, key in ((a, "shape"), (b, "shapeBack")):
                if key in opts:
                    node, ifn = ref.split(":"); s = opts[key]
                    l3.sh("ip", "-n", self.ns[node], "link", "set", ifn, "txqueuelen", "1000")
                    l3.sh("tc", "-n", self.ns[node], "qdisc", "replace", "dev", ifn, "root", "tbf",
                          "rate", str(s["rate"]), "burst", str(s["burst"]), "limit", str(s["limit"]))
                    self.shaped.append((node, ifn))

    def start_stp(self):
        """Turn spanning tree on: the bridges' clocks (hello timer) start now, as the engine's start at time 0."""
        for n in self.stp_nodes:
            st = n["stp"]
            l3.sh("ip", "-n", self.ns[n["name"]], "link", "set", "br0", "type", "bridge", "stp_state", "1", "priority", str(st.get("priority", 32768)),
                  "hello_time", str(int(st.get("hello", 2) * 100)), "max_age", str(int(st.get("maxAge", 20) * 100)), "forward_delay", str(int(st.get("forwardDelay", 15) * 100)))

    def drops(self):
        out = {}
        for node, ifn in self.shaped:
            q = json.loads(l3.sh("tc", "-n", self.ns[node], "-s", "-j", "qdisc", "show", "dev", ifn))
            out[f"{node}:{ifn}"] = sum(x.get("drops", 0) for x in q if x.get("kind") == "tbf")
        return out

    def act(self, a):
        if a["do"] == "wait":
            time.sleep(a["seconds"]); return {"waited": a["seconds"]}
        if a["do"] == "udpBurst":
            return json.loads(l3.nsx(self.ns[a["src"]], sys.executable, str(HERE / "burst.py"),
                                     a["dst"], str(a["port"]), str(a["count"]), str(a["size"])))
        return super().act(a)


def kernel_run(name):
    spec = json.loads((HERE / f"{name}.json").read_text()); actions = json.loads((HERE / f"{name}.actions.json").read_text())
    k = ShapedNet(spec); out = []; stp = bool(k.stp_nodes); cum = 0.0
    try:
        time.sleep(1)  # let every bucket fill
        if stp:
            # A spanning-tree window's hello count depends on the phase of the kernel's hello timer, so start the tree at a known
            # moment (half a second after a wall-clock second) and keep every action on the engine's schedule: the engine's tree
            # starts at time 0 with the first action, and hellos then fall in the same windows on both sides. The first window
            # begins before the tree starts, so it holds the start-up BPDU too, as the engine's does.
            time.sleep(1 - time.time() % 1); t_base = int(time.time()) + 0.5; time.sleep(max(t_base - time.time(), 0))
        started = False
        for a in actions:
            if stp: time.sleep(max(t_base + cum - time.time(), 0))
            k.flush(); before, dbefore = k.counters(), k.drops()
            if stp and not started: k.start_stp(); started = True
            if stp and a["do"] == "wait":
                time.sleep(max(t_base + cum + a["seconds"] - time.time(), 0)); r = {"waited": a["seconds"]}
            else: r = k.act(a)
            if stp: cum += a.get("seconds", 0) + a.get("settle", 1)
            time.sleep(a.get("settle", 1)); after, dafter = k.counters(), k.drops()
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
        print("Needs root, `unshare`, iproute2 and `tc`. Skipping."); return 0
    kern = json.loads(subprocess.run(["unshare", "-n", "-m", sys.executable, __file__, "--inner"], check=True,
                                     capture_output=True, text=True, timeout=600).stdout)
    rows, detail = [], {}
    for name in SPECS:
        eng = json.loads(l3.sh("node", str(ROOT / "engine" / "tools" / "run_spec.mjs"), str(HERE / f"{name}.json"), str(HERE / f"{name}.actions.json")))
        for e, k in zip(eng, kern[name]):
            a = e["action"]
            er = {x: v for x, v in e["result"].items() if x != "time"}    # the engine's clock reading is not a network behavior
            same = l3.comparable(er) == l3.comparable(k["result"])
            keys = sorted(set(e["frames"]) | set(k["frames"]))
            fd = {key: (e["frames"].get(key, 0), k["frames"].get(key, 0)) for key in keys if e["frames"].get(key, 0) != k["frames"].get(key, 0)}
            ed, kd = e.get("drops", {}), k["drops"]
            dd = {key: (ed.get(key, 0), kd.get(key, 0)) for key in sorted(set(ed) | set(kd)) if ed.get(key, 0) != kd.get(key, 0)}
            ok = same and not fd and not dd
            what = (f'{a["do"]} {a["src"]} → {a["dst"]}' if "src" in a else f'{a["do"]} {a["seconds"]} s') + (f' ×{a["count"]} of {a["size"]} B' if "count" in a else "")
            drops = ", ".join(f"{k_} {v}" for k_, v in ed.items()) or "none"
            rows.append((name, what, f'{sum(e["frames"].values())} frames on {len(e["frames"])} cable directions', drops, "✓" if ok else "✗"))
            if not ok: detail[f"{name}: {what}"] = {"engine": e["result"], "kernel": k["result"], "frame_diffs": fd, "drop_diffs": dd}
    md = ["| Network | Action | Frames (engine = Linux, cable by cable?) | Queue drops (engine = Linux?) | Match |", "|---|---|---|---|---|"]
    md += [f"| {a} | {b} | {c} | {d} | {e} |" for a, b, c, d, e in rows]
    (HERE / "results.md").write_text("\n".join(md) + "\n")
    (HERE / "mismatches.json").write_text(json.dumps(detail, indent=1))
    print("\n".join(md))
    if detail: print(json.dumps(detail, indent=1)[:4000]); l3.gh_note("error", "Links engine vs Linux mismatch", json.dumps(detail))
    return 0 if not detail else 1


if __name__ == "__main__":
    if sys.argv[1:] == ["--inner"]: inner()
    else: sys.exit(main())
