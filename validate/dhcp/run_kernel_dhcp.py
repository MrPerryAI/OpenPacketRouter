#!/usr/bin/env python3
"""DHCP: the engine vs a real dnsmasq server and busybox udhcpc clients, frame for frame.

    sudo python3 validate/dhcp/run_kernel_dhcp.py        # on a Mac: validate/docker/run.sh dhcp

Builds each spec from network namespaces like validate/l3 (it reuses that harness). Interfaces marked
"dhcp" get no address; a node with services.dhcp runs dnsmasq (no DNS, no ping check) on its subnet, plus
`pools` for subnets behind a relay; a router with services.dhcpRelay runs dnsmasq in relay mode
(`--dhcp-relay=CLIENT_SIDE_ADDR,SERVER`; Debian/Ubuntu busybox has no `dhcprelay`). Set OPR_CAPTURE=1 to print a tcpdump of
the relay router's interfaces (needs tcpdump).
The `dhcp` action runs `udhcpc -n -q -t TRIES -T INTERVAL` (no script: the client only reports its lease).
Compared: the result (address, server, lease time) and the frames sent on every cable direction.
"""
import copy, json, os, re, shutil, subprocess, sys, tempfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "validate" / "l3"))
import run_kernel_l3 as l3  # noqa: E402

SPECS = ["dhcp-lan", "dhcp-relay"]


class DhcpNet(l3.KernelNet):
    def __init__(self, spec):
        bare = copy.deepcopy(spec)
        for n in bare["nodes"]:
            if n.get("ifaces"): n["ifaces"] = {k: v for k, v in n["ifaces"].items() if v != "dhcp"}
        super().__init__(bare)
        self.spec = spec
        self.tmp = tempfile.mkdtemp()
        for n in spec["nodes"]:
            d = (n.get("services") or {}).get("dhcp")
            if not d: continue
            ifn = next(k for k, v in n["ifaces"].items() if v != "dhcp")
            mask = l3.sh("python3", "-c", f"import ipaddress;print(ipaddress.ip_interface('{n['ifaces'][ifn]}').netmask)").strip()
            args = ["dnsmasq", "--keep-in-foreground", "--port=0", "--no-resolv", "--no-hosts", "--no-ping", "--user=root",
                    f"--interface={ifn}", "--bind-interfaces", f"--dhcp-range={d['range'][0]},{d['range'][1]},{mask},{d.get('lease', 3600)}",
                    f"--dhcp-leasefile={self.tmp}/{n['name']}.leases", f"--pid-file={self.tmp}/{n['name']}.pid"]
            args.append(f"--dhcp-option=3,{d['router']}" if d.get("router") else "--dhcp-option=3")
            for q in d.get("pools", []):   # subnets behind a relay (giaddr)
                args.append(f"--dhcp-range={q['range'][0]},{q['range'][1]},{q.get('mask', '255.255.255.0')},{d.get('lease', 3600)}")
            self.procs.append(subprocess.Popen(["ip", "netns", "exec", self.ns[n["name"]], *args], stderr=subprocess.DEVNULL))
        for n in spec["nodes"]:
            r = (n.get("services") or {}).get("dhcpRelay")
            if not r: continue
            ns = self.ns[n["name"]]
            dev = re.search(r"dev (\S+)", l3.sh("ip", "-n", ns, "route", "get", r["server"]))[1]
            clients = r.get("clients") or [i for i in n["ifaces"] if i != dev]
            log = open(f"{self.tmp}/{n['name']}.relay.log", "w")
            # dnsmasq's relay mode (Debian/Ubuntu busybox builds leave out `dhcprelay`); the engine models it.
            cmd = ["dnsmasq", "--keep-in-foreground", "--port=0", "--no-resolv", "--no-hosts", "--user=root", "--log-dhcp",
                   f"--pid-file={self.tmp}/{n['name']}.relay.pid", *[f"--interface={c}" for c in clients],
                   *[f"--dhcp-relay={n['ifaces'][c].split('/')[0]},{r['server']}" for c in clients]]
            print(f"relay on {n['name']}: {' '.join(cmd)}", file=sys.stderr)
            self.procs.append(subprocess.Popen(["ip", "netns", "exec", ns, *cmd], stderr=log, stdout=log))
            self.relay_logs = getattr(self, "relay_logs", []) + [f"{self.tmp}/{n['name']}.relay.log"]
        time.sleep(1)

    def act(self, a):
        if a["do"] != "dhcp":
            return super().act(a)
        node = next(n for n in self.spec["nodes"] if n["name"] == a["src"])
        ifn = a.get("iface") or next(k for k, v in node["ifaces"].items() if v == "dhcp")
        p = subprocess.run(["ip", "netns", "exec", self.ns[a["src"]], "busybox", "udhcpc", "-i", ifn, "-n", "-q", "-f",
                            "-s", "/bin/true", "-t", str(a.get("tries", 3)), "-T", str(a.get("interval", 1))],
                           capture_output=True, text=True, timeout=60)
        m = re.search(r"lease of (\S+) obtained from (\S+), lease time (\d+)", p.stdout + p.stderr)
        return {"ok": True, "ip": m[1], "server": m[2], "lease": int(m[3])} if m else {"ok": False, "error": "no offer"}


def kernel_run(name):
    spec = json.loads((HERE / f"{name}.json").read_text()); actions = json.loads((HERE / f"{name}.actions.json").read_text())
    k = DhcpNet(spec); out = []
    try:
        for a in actions:
            k.flush(); before = k.counters()
            caps = []
            if os.environ.get("OPR_CAPTURE") and shutil.which("tcpdump"):   # debugging aid: every frame seen by the relay router
                for n in spec["nodes"]:
                    if (n.get("services") or {}).get("dhcpRelay"):
                        for ifn in n["ifaces"]:
                            caps.append((f"{n['name']}:{ifn}", subprocess.Popen(["ip", "netns", "exec", k.ns[n["name"]], "tcpdump", "-l", "-n", "-e", "-i", ifn],
                                                                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)))
                time.sleep(0.5)
            r = k.act(a); time.sleep(a.get("settle", 1)); after = k.counters()
            for where, c in caps:
                c.terminate(); print(f"capture {where}:\n" + c.communicate()[0], file=sys.stderr)
            out.append({"action": a, "result": r, "frames": {key: after[key] - before.get(key, 0) for key in after if after[key] - before.get(key, 0)}})
    finally:
        for f in getattr(k, "relay_logs", []):
            print(f"relay log {f}: {open(f).read()[:500]!r}", file=sys.stderr)
        k.close()
    return out


def inner():
    l3.sh("mount", "-t", "tmpfs", "none", "/run")
    print(json.dumps({name: kernel_run(name) for name in SPECS}))


def main():
    need = ["unshare", "ip", "dnsmasq", "busybox"]
    if os.geteuid() != 0 or not all(shutil.which(x) for x in need):
        print(f"Needs root and {', '.join(need)}. Skipping."); return 0
    applets = [a for a in subprocess.run(["busybox", "--list"], capture_output=True, text=True).stdout.split() if "dhcp" in a]
    print("busybox dhcp applets:", applets)
    p = subprocess.run(["unshare", "-n", "-m", sys.executable, __file__, "--inner"], capture_output=True, text=True, timeout=600)
    if p.stderr: print(p.stderr[-2000:])
    if p.returncode:
        l3.gh_note("error", "DHCP kernel side failed", f"busybox dhcp applets: {applets}\n{p.stderr[-3000:]}"); return 1
    kern = json.loads(p.stdout)
    rows, detail = [], {}
    for name in SPECS:
        eng = json.loads(l3.sh("node", str(ROOT / "engine" / "tools" / "run_spec.mjs"), str(HERE / f"{name}.json"), str(HERE / f"{name}.actions.json")))
        for e, k in zip(eng, kern[name]):
            a = e["action"]; same = e["result"] == k["result"]
            keys = sorted(set(e["frames"]) | set(k["frames"]))
            fd = {key: (e["frames"].get(key, 0), k["frames"].get(key, 0)) for key in keys if e["frames"].get(key, 0) != k["frames"].get(key, 0)}
            ok = same and not fd
            res = e["result"]
            summary = f'{res["ip"]} from {res["server"]}, lease {res["lease"]} s' if res.get("ok") else res.get("error")
            rows.append((name, f'dhcp {a["src"]}', summary, f'{sum(e["frames"].values())} frames on {len(e["frames"])} cable directions', "✓" if ok else "✗"))
            if not ok: detail[f'{name}: dhcp {a["src"]}'] = {"engine": e["result"], "kernel": k["result"], "frame_diffs": fd}
    md = ["| Network | Action | Engine result (same in Linux?) | Frames (engine = Linux, cable by cable?) | Match |", "|---|---|---|---|---|"]
    md += [f"| {a} | {b} | {c} | {d} | {e} |" for a, b, c, d, e in rows]
    (HERE / "results.md").write_text("\n".join(md) + "\n")
    (HERE / "mismatches.json").write_text(json.dumps(detail, indent=1))
    print("\n".join(md))
    if detail:
        print(json.dumps(detail, indent=1)[:4000])
        l3.gh_note("error", "DHCP engine vs Linux mismatch", f"busybox dhcp applets: {applets}\n{json.dumps(detail)}\n{p.stderr[-6000:]}")
    return 0 if not detail else 1


if __name__ == "__main__":
    if sys.argv[1:] == ["--inner"]: inner()
    else: sys.exit(main())
