#!/usr/bin/env python3
"""TCP: the engine vs the real Linux TCP stack (python sockets), frame for frame.

    sudo python3 validate/tcp/run_kernel_tcp.py        # on a Mac: validate/docker/run.sh tcp

Builds each spec from network namespaces like validate/l3 (it reuses that harness). A node with
services.tcp = {"7": "echo"} runs an echo server on those ports. The `tcp` action connects from the
client (tcp_probe.py), sends SIZE bytes, reads the echo and closes. Compared: the result, the TCP
segments seen on the client's cable (in order, with flags and payload length), and the frames on every
cable direction.
"""
import json, os, shutil, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "validate" / "l3"))
import run_kernel_l3 as l3  # noqa: E402

SPECS = ["tcp-lan"]


class TcpNet(l3.KernelNet):
    def __init__(self, spec):
        super().__init__(spec)
        for n in spec["nodes"]:
            ports = (n.get("services") or {}).get("tcp")
            if ports:
                self.procs.append(subprocess.Popen(["ip", "netns", "exec", self.ns[n["name"]], sys.executable, str(HERE / "tcp_server.py"), *ports.keys()]))
        time.sleep(0.5)

    def act(self, a):
        if a["do"] != "tcp":
            return super().act(a)
        node = next(n for n in self.spec["nodes"] if n["name"] == a["src"])
        ifn = next(iter(node["ifaces"]))
        p = subprocess.run(["ip", "netns", "exec", self.ns[a["src"]], sys.executable, str(HERE / "tcp_probe.py"), ifn, a["dst"], str(a["port"]),
                            str(a.get("size", 100)), str(a.get("timeout", 5))], capture_output=True, text=True, timeout=60)
        return json.loads(p.stdout)


def kernel_run(name):
    spec = json.loads((HERE / f"{name}.json").read_text()); actions = json.loads((HERE / f"{name}.actions.json").read_text())
    k = TcpNet(spec); out = []
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


comparable = lambda r: {k: v for k, v in r.items() if k != "rtt_ms"}


def main():
    if os.geteuid() != 0 or not shutil.which("unshare") or not shutil.which("ip"):
        print("Needs root, `unshare` and iproute2. Skipping."); return 0
    proc = subprocess.run(["unshare", "-n", "-m", sys.executable, __file__, "--inner"], capture_output=True, text=True, timeout=600)
    if proc.returncode:
        print("kernel side failed:\n" + proc.stderr[-3000:]); return 1
    kern = json.loads(proc.stdout)
    rows, detail = [], {}
    for name in SPECS:
        eng = json.loads(l3.sh("node", str(ROOT / "engine" / "tools" / "run_spec.mjs"), str(HERE / f"{name}.json"), str(HERE / f"{name}.actions.json")))
        for e, k in zip(eng, kern[name]):
            a = e["action"]; same = comparable(e["result"]) == comparable(k["result"])
            keys = sorted(set(e["frames"]) | set(k["frames"]))
            fd = {key: (e["frames"].get(key, 0), k["frames"].get(key, 0)) for key in keys if e["frames"].get(key, 0) != k["frames"].get(key, 0)}
            ok = same and not fd
            res = e["result"]
            what = f'tcp {a["src"]} → {a["dst"]}:{a["port"]}' + (f' ({a.get("size", 100)} bytes)' if res.get("ok") else "")
            summary = (f'echo of {res["bytes"]} bytes' if res.get("ok") else res.get("error")) + " · " + " ".join(w.replace("out ", ">").replace("in ", "<") for w in res["wire"])
            rows.append((name, what, summary, f'{sum(e["frames"].values())} frames on {len(e["frames"])} cable directions', "✓" if ok else "✗"))
            if not ok: detail[f"{name}: {what}"] = {"engine": comparable(e["result"]), "kernel": comparable(k["result"]), "frame_diffs": fd}
    md = ["| Network | Action | Engine result and client-side segments (same in Linux?) | Frames (engine = Linux, cable by cable?) | Match |", "|---|---|---|---|---|"]
    md += [f"| {a} | {b} | {c} | {d} | {e} |" for a, b, c, d, e in rows]
    (HERE / "results.md").write_text("\n".join(md) + "\n")
    (HERE / "mismatches.json").write_text(json.dumps(detail, indent=1))
    print("\n".join(md))
    if detail: print(json.dumps(detail, indent=1)[:6000])
    return 0 if not detail else 1


if __name__ == "__main__":
    if sys.argv[1:] == ["--inner"]: inner()
    else: sys.exit(main())
