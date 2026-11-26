#!/usr/bin/env python3
"""Server services: the engine vs real Linux tools, frame for frame.

    sudo python3 validate/services/run_kernel_services.py        # on a Mac: validate/docker/run.sh services

Builds each spec from network namespaces like validate/l3 (it reuses that harness). Syslog: a node with services.syslog runs a UDP 514
receiver (syslog_server.py) that stores each datagram; the client side is util-linux `logger -n HOST -P 514 -d --rfc3164`, the real
syslog sender. Compared per action: the messages the receiver stored (priority, tag and text; the timestamp and hostname are
dropped from both sides, since they come from the wall clock and the host's name) and the frames on every cable direction.
"""
import json, os, re, shutil, subprocess, sys, tempfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "validate" / "l3"))
import run_kernel_l3 as l3  # noqa: E402

SPECS = ["syslog-lan", "ntp-lan"]
STAMPED = re.compile(r"^(<\d+>)\w{3} [ \d]\d \d\d:\d\d:\d\d \S+ (.*)$")


def norm(msg):
    m = STAMPED.match(msg)
    return f"{m[1]} {m[2]}" if m else f"UNPARSED {msg}"


class ServicesNet(l3.KernelNet):
    def __init__(self, spec):
        super().__init__(spec)
        self.tmp = tempfile.mkdtemp(); self.logs = {}
        for n in spec["nodes"]:
            if (n.get("services") or {}).get("ntp"):
                f = f"{self.tmp}/{n['name']}.log"; open(f, "w").close(); self.logs[n["name"]] = f
                self.procs.append(subprocess.Popen(["ip", "netns", "exec", self.ns[n["name"]], sys.executable, str(HERE / "ntp_server.py"), f, str(n["services"]["ntp"])]))
            if (n.get("services") or {}).get("syslog"):
                f = f"{self.tmp}/{n['name']}.log"; open(f, "w").close(); self.logs[n["name"]] = f
                self.procs.append(subprocess.Popen(["ip", "netns", "exec", self.ns[n["name"]], sys.executable, str(HERE / "syslog_server.py"), f]))
        time.sleep(0.5)

    def lines(self):
        return {name: Path(f).read_text().splitlines() for name, f in self.logs.items()}

    def act(self, a):
        if a["do"] == "ntp":
            before = self.lines()
            r = subprocess.run(["ip", "netns", "exec", self.ns[a["src"]], "ntpdate", "-q", "-u", a["dst"]], capture_output=True, text=True, timeout=60)
            # classic ntpdate: "server 10.0.0.10, stratum 2, offset ..."; ntpsec's: "2026-11-26 12:00:00.1 (+0000) +0.0 +/- 0.1 10.0.0.10 s2 no-leap"
            m = re.search(r"server (\S+), stratum (\d+)", r.stdout) or re.search(r"(\S+) s(\d+) \S+\s*$", r.stdout, re.M)
            time.sleep(a.get("settle", 1)); after = self.lines()
            got = [m_ for name in sorted(after) for m_ in after[name][len(before[name]):]]
            if r.returncode or not m: return {"ok": False, "error": (r.stdout + r.stderr).strip()[-200:], "received": got}
            return {"ok": True, "from": m[1], "stratum": int(m[2]), "received": got}
        if a["do"] != "syslog":
            return super().act(a)
        before = self.lines()
        r = subprocess.run(["ip", "netns", "exec", self.ns[a["src"]], "logger", "-n", a["dst"], "-P", "514", "-d", "--rfc3164",
                            "-t", a.get("tag", "user"), "-p", f'{a.get("facility", "user")}.{a.get("severity", "notice")}', a["message"]],
                           capture_output=True, text=True, timeout=30)
        if r.returncode: return {"ok": False, "error": f"logger failed: {r.stderr.strip()}"}
        time.sleep(a.get("settle", 1))
        after = self.lines()
        return {"ok": True, "received": [m for name in sorted(after) for m in after[name][len(before[name]):]]}

    def close(self):
        super().close(); shutil.rmtree(self.tmp, ignore_errors=True)


def kernel_run(name):
    spec = json.loads((HERE / f"{name}.json").read_text()); actions = json.loads((HERE / f"{name}.actions.json").read_text())
    k = ServicesNet(spec); out = []
    try:
        for a in actions:
            k.flush(); before = k.counters(); r = k.act(a); time.sleep(0.3); after = k.counters()
            out.append({"action": a, "result": r, "frames": {key: after[key] - before.get(key, 0) for key in after if after[key] - before.get(key, 0)}})
    finally:
        k.close()
    return out


def inner():
    l3.sh("mount", "-t", "tmpfs", "none", "/run")
    print(json.dumps({name: kernel_run(name) for name in SPECS}))


def comparable(r, kind):
    r = {k: v for k, v in r.items() if k != "rtt_ms"}
    r.pop("version", None)   # ntpdate does not print the version it sent; the server's log of the request has it
    if "received" in r and kind == "syslog": r["received"] = [norm(m) for m in r["received"]]
    return r


def main():
    need = ["unshare", "ip", "logger", "ntpdate"]
    if os.geteuid() != 0 or not all(shutil.which(x) for x in need):
        print("Needs root, unshare, iproute2 and util-linux logger.")
        if os.environ.get("GITHUB_ACTIONS"): print("This check is required in CI: failing instead of skipping."); return 1
        print("Skipping."); return 0
    proc = subprocess.run(["unshare", "-n", "-m", sys.executable, __file__, "--inner"], capture_output=True, text=True, timeout=900)
    if proc.returncode:
        print("kernel side failed:\n" + proc.stderr[-3000:]); l3.gh_note("error", "services kernel side failed", proc.stderr[-6000:]); return 1
    kern = json.loads(proc.stdout)
    rows, detail = [], {}
    for name in SPECS:
        eng = json.loads(l3.sh("node", str(ROOT / "engine" / "tools" / "run_spec.mjs"), str(HERE / f"{name}.json"), str(HERE / f"{name}.actions.json")))
        assert len(eng) == len(kern[name]), f"{name}: engine ran {len(eng)} actions, Linux {len(kern[name])}"
        for e, k in zip(eng, kern[name]):
            a = e["action"]; same = comparable(e["result"], a["do"]) == comparable(k["result"], a["do"])
            keys = sorted(set(e["frames"]) | set(k["frames"]))
            fd = {key: (e["frames"].get(key, 0), k["frames"].get(key, 0)) for key in keys if e["frames"].get(key, 0) != k["frames"].get(key, 0)}
            ok = same and not fd
            res = comparable(e["result"], a["do"])
            what = f'syslog {a["src"]} → {a["dst"]}: {a["message"]}' if a["do"] == "syslog" else f'ntp {a["src"]} → {a["dst"]}'
            rows.append((name, what, ", ".join(res.get("received", [])) or "(nothing stored)", f'{sum(e["frames"].values())} frames on {len(e["frames"])} cable directions', "✓" if ok else "✗"))
            if not ok: detail[f"{name}: {what}"] = {"engine": comparable(e["result"], a["do"]), "linux": comparable(k["result"], a["do"]), "frame_diffs": fd}
    md = ["| Network | Action | Stored by the receiver (same in Linux?) | Frames (engine = Linux, cable by cable?) | Match |", "|---|---|---|---|---|"]
    md += [f"| {a} | {b} | {c} | {d} | {e} |" for a, b, c, d, e in rows]
    (HERE / "results.md").write_text("\n".join(md) + "\n"); (HERE / "mismatches.json").write_text(json.dumps(detail, indent=1))
    print("\n".join(md))
    l3.gh_note("notice", "services results.md", "\n".join(md)); l3.gh_note("notice", "services mismatches.json", json.dumps(detail))
    if detail: print(json.dumps(detail, indent=1)[:6000]); l3.gh_note("error", "services engine vs Linux mismatch", json.dumps(detail))
    return 0 if not detail else 1


if __name__ == "__main__":
    if sys.argv[1:] == ["--inner"]: inner()
    else: sys.exit(main())
