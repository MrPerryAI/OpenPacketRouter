#!/usr/bin/env python3
"""Port mirroring (SPAN): the engine vs Linux `tc ... action mirred`, frame for frame.

    sudo python3 validate/span/run_kernel_span.py        # on a Mac: validate/docker/run.sh span

The switch is a kernel bridge (validate/l2's Net). A monitor session's destination port is taken out of the bridge, and every source
port gets a clsact qdisc with a matchall filter and `action mirred egress mirror dev DEST` on ingress (frames the port receives),
egress (frames it sends) or both. The same pings run in the engine; results and the frame count on every cable direction (including
the monitor cables) are compared.
"""
import json, os, shutil, struct, subprocess, sys, tempfile, time
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
                        nsx(ns, "tc", "qdisc", "add", "dev", port, "clsact"); hooks.add(port)
                    for hook in ({"rx": ["ingress"], "tx": ["egress"], "both": ["ingress", "egress"]}[d]):
                        nsx(ns, "tc", "filter", "add", "dev", port, hook, "matchall", "action", "mirred", "egress", "mirror", "dev", s["destination"])
        # What each monitor port sends, in order: tcpdump on the switch side of the monitor cable (outgoing frames only)
        self.macs = {sh("ip", "netns", "exec", self.ns[node], "cat", f"/sys/class/net/{ifn}/address").strip(): f"{node}:{ifn}" for (node, ifn) in self.ifmap}
        self.tmp = tempfile.mkdtemp(); self.caps = []; self.procs = []; self.seen = {}
        for n in spec["nodes"]:
            for s in (n.get("monitor") or {}).values():
                f = f"{self.tmp}/{n['name']}-{s['destination']}.pcap"
                self.procs.append(subprocess.Popen(["ip", "netns", "exec", self.ns[n["name"]], "tcpdump", "-i", s["destination"], "-Q", "out", "-U", "-n", "-s", "0", "-Z", "root", "-w", f, "arp or ip"],
                                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
                self.caps.append((f"{n['name']}:{s['destination']}>{self.ifmap[(n['name'], s['destination'])]}", f))
        time.sleep(1.5)

    def mirrored(self):
        """Frames sent per monitor cable direction since the last call, in capture order: "src>dst what" with MACs named like the engine does."""
        nm = lambda b: ":".join(f"{x:02x}" for x in b)
        nice = lambda m: self.macs.get(m, m)
        out = {}
        for key, f in self.caps:
            try: data = open(f, "rb").read()
            except OSError: continue
            if len(data) < 24: continue
            end = "<" if data[:4] == b"\xd4\xc3\xb2\xa1" else ">"
            pos = 24; n = 0
            while pos + 16 <= len(data):
                incl = struct.unpack(end + "I", data[pos + 8:pos + 12])[0]
                if pos + 16 + incl > len(data): break
                pkt = data[pos + 16:pos + 16 + incl]; pos += 16 + incl; n += 1
                if n <= self.seen.get(key, 0): continue
                dst, src, et = nm(pkt[0:6]), nm(pkt[6:12]), pkt[12:14]
                if et == b"\x08\x06": what = "arp " + {1: "request", 2: "reply"}.get(struct.unpack(">H", pkt[20:22])[0], "?")
                elif et == b"\x08\x00":
                    proto = pkt[23]; what = "icmp " + str(pkt[14 + (pkt[14] & 15) * 4]) if proto == 1 else f"ip proto {proto}"
                else: continue
                out.setdefault(key, []).append(f"{nice(src)}>{nice(dst)} {what}")
            self.seen[key] = n
        return out

    def close(self):
        for p in self.procs: p.terminate()
        super().close()


def kernel_run(name):
    spec = json.loads((HERE / f"{name}.json").read_text()); acts = json.loads((HERE / f"{name}.actions.json").read_text())
    k = SpanNet(spec); out = []
    try:
        for a in acts:
            k.flush(); k.mirrored(); before = k.counters(); r = k.ping(a["src"], a["dst"], a.get("timeout", 2)); time.sleep(a.get("settle", 1)); after = k.counters(); time.sleep(0.3)
            out.append({"action": a, "result": r, "mirrored": k.mirrored(), "frames": {x: after[x] - before.get(x, 0) for x in after if after[x] - before.get(x, 0)}})
    finally: k.close()
    return out


def inner():
    sh("mount", "-t", "tmpfs", "none", "/run")
    print(json.dumps({n: kernel_run(n) for n in SPECS}))


def main():
    if os.geteuid() != 0 or not shutil.which("unshare") or not shutil.which("tc") or not shutil.which("tcpdump"):
        print("Needs root, `unshare`, iproute2 (ip, tc) and tcpdump.")
        if os.environ.get("GITHUB_ACTIONS"): print("This check is required in CI: failing instead of skipping."); return 1
        print("Skipping."); return 0
    proc = subprocess.run(["unshare", "-n", "-m", sys.executable, __file__, "--inner"], capture_output=True, text=True, timeout=900)
    if proc.returncode:
        print("kernel side failed:\n" + proc.stderr[-3000:]); l3.gh_note("error", "SPAN kernel side failed", proc.stderr[-6000:]); return 1
    kern = json.loads(proc.stdout)
    md = ["| Network | Action | Result | Frames and mirrored frame contents (engine = Linux, in order?) | Match |", "|---|---|---|---|---|"]; detail = {}
    for name in SPECS:
        eng = json.loads(sh("node", str(ROOT / "engine/tools/run_spec.mjs"), str(HERE / f"{name}.json"), str(HERE / f"{name}.actions.json")))
        assert len(eng) == len(kern[name]), f"{name}: engine ran {len(eng)} actions, Linux {len(kern[name])}"
        for e, k in zip(eng, kern[name]):
            a = e["action"]; same = comparable(e["result"]) == comparable(k["result"])
            keys = set(e["frames"]) | set(k["frames"]); diffs = {x: (e["frames"].get(x, 0), k["frames"].get(x, 0)) for x in keys if e["frames"].get(x, 0) != k["frames"].get(x, 0)}
            mdiffs = {x: (e["mirrored"].get(x, []), k["mirrored"].get(x, [])) for x in sorted(set(e["mirrored"]) | set(k["mirrored"])) if e["mirrored"].get(x, []) != k["mirrored"].get(x, [])}
            ok = same and not diffs and not mdiffs
            mon = sum(v for x, v in e["frames"].items() if x.startswith("SW:p4") or x.startswith("SW:p5"))
            md.append(f'| {name} | ping {a["src"]} → {a["dst"]} | {"ok" if e["result"].get("ok") else "no reply"} | {sum(e["frames"].values())} frames on {len(e["frames"])} cable directions, {mon} copies to monitors, contents checked | {"✓" if ok else "✗"} |')
            if not ok: detail[f"{name}: {a}"] = {"engine": e, "linux": k, "frame_diffs": diffs, "mirrored_diffs (engine, linux)": mdiffs}
    (HERE / "results.md").write_text("\n".join(md) + "\n"); (HERE / "mismatches.json").write_text(json.dumps(detail, indent=1))
    print("\n".join(md)); l3.gh_note("notice", "SPAN results.md", "\n".join(md)); l3.gh_note("notice", "SPAN mismatches.json", json.dumps(detail, indent=1))
    if detail: print(json.dumps(detail, indent=1)[:5000]); l3.gh_note("error", "SPAN engine vs Linux mismatch", json.dumps(detail))
    return 0 if not detail else 1


if __name__ == "__main__":
    if sys.argv[1:] == ["--inner"]: inner()
    else: sys.exit(main())
