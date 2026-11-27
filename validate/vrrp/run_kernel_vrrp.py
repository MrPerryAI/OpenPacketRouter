#!/usr/bin/env python3
"""VRRP: the engine vs keepalived in Linux namespaces: who is master, and the advertisements on every cable.

Each router with a `vrrp` key runs its own `keepalived` (vrrp only, one namespace per router, the cables are veth
pairs, the switch is a Linux bridge), configured from the spec: state BACKUP, priority, advert_int, nopreempt when
`preempt` is false, the virtual address on the cable's interface. The same steps run in the engine
(engine/tools/run_vrrp.mjs). Compared at every snapshot:

  - which routers are master (on Linux: the virtual address is configured on the interface; keepalived adds it
    only while master);
  - whether a host can ping the virtual address (a real ping on Linux);
  - the advertisements on every cable direction between two snapshots: the set of distinct ones (source address,
    vrid, priority, interval, TTL, destination MAC) and how many there were (exact: counted from the first
    advert after the previous snapshot over whole advert intervals ending mid-interval, the same span on both sides);
  - the gratuitous ARPs on every cable direction (exact frames and exact counts). keepalived is pinned to one ARP
    per takeover (garp_master_repeat 1, no delayed second burst, no refresh), which is what the engine sends.

Snapshots sit on plateaus (several seconds after each change), because the instant of a takeover differs by a
fraction of a second between a real kernel under load and the engine.

Needs root, unshare, iproute2, tcpdump and keepalived; on a Mac run validate/docker/run.sh vrrp.
"""
import json, os, shutil, struct, subprocess, sys, tempfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "validate" / "l3"))
import run_kernel_l3 as l3  # noqa: E402

SPECS = ["vrrp-preempt", "vrrp-nopreempt", "vrrp-backup-flap"]


def netfile(name): return HERE / f"{name}.net"      # .net, not .json: the CLI round-trip test reads every *.json spec


def mac_s(b): return ":".join(f"{x:02x}" for x in b)


def read_pcap(path):
    data = Path(path).read_bytes() if Path(path).exists() else b""
    if len(data) < 24: return []
    magic = struct.unpack("<I", data[:4])[0]
    scale = 1e-9 if magic in (0xa1b23c4d, 0x4d3cb2a1) else 1e-6
    e = "<" if magic in (0xa1b2c3d4, 0xa1b23c4d) else ">"
    off, out = 24, []
    while off + 16 <= len(data):
        sec, frac, incl, _ = struct.unpack(e + "IIII", data[off:off + 16]); off += 16
        frame = data[off:off + incl]; off += incl
        if len(frame) >= 42 and frame[12:14] == b"\x08\x06":
            ip = lambda b: ".".join(str(x) for x in b)
            spa, tpa = ip(frame[28:32]), ip(frame[38:42])
            if spa == tpa:  # gratuitous only: ordinary ARP for the ping depends on the host's neighbor timers (see race_replies for the one Linux-only frame left out)
                out.append({"t": sec + frac * scale, "kind": "arp", "dst": mac_s(frame[0:6]), "src": mac_s(frame[6:12]), "op": struct.unpack(">H", frame[20:22])[0],
                            "sha": mac_s(frame[22:28]), "spa": spa, "tha": mac_s(frame[32:38]), "tpa": tpa})
            continue
        if len(frame) < 34 or frame[12:14] != b"\x08\x00" or frame[23] != 112: continue
        ihl = (frame[14] & 0x0f) * 4; v = frame[14 + ihl:]
        if len(v) < 8: continue
        out.append({"t": sec + frac * scale, "dst": mac_s(frame[0:6]), "src": ".".join(str(x) for x in frame[26:30]), "ttl": frame[22],
                    "vrid": v[1], "priority": v[2], "interval": v[5]})
    return out


class VrrpNet(l3.KernelNet):
    def __init__(self, spec):
        super().__init__(spec)
        self.tmp = tempfile.mkdtemp(); os.chmod(self.tmp, 0o755); self.caps = []; self.talkers = [n for n in spec["nodes"] if n.get("vrrp")]
        for n in self.talkers:
            for ifn in self.ifaces(n):
                f = f"{self.tmp}/{n['name']}-{ifn}.pcap"
                p = subprocess.Popen(["ip", "netns", "exec", self.ns[n["name"]], "tcpdump", "-i", ifn, "-Q", "out", "-U", "-n", "-s", "0", "-Z", "root", "-w", f, "ip proto 112 or arp"],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                self.caps.append((f"{n['name']}:{ifn}>{self.ifmap[(n['name'], ifn)]}", f, p))
        time.sleep(1.5)
        self.t0 = time.time()
        for n in self.talkers:
            g = n["vrrp"][0]; conf = f"{self.tmp}/{n['name']}.conf"
            Path(conf).write_text(f"""global_defs {{
  router_id {n['name']}
}}
vrrp_instance VI_1 {{
  state BACKUP
  interface {g['iface']}
  virtual_router_id {g['vrid']}
  priority {g.get('priority', 100)}
  advert_int {g.get('interval', 1)}
  garp_master_repeat 1
  garp_master_delay 0
  garp_master_refresh 0
{'' if g.get('preempt', True) else '  nopreempt' + chr(10)}  virtual_ipaddress {{
    {g['ip']}/{n['ifaces'][g['iface']].split('/')[1]} dev {g['iface']}
  }}
}}
""")
            self.procs.append(subprocess.Popen(["ip", "netns", "exec", self.ns[n["name"]], "keepalived", "-f", conf, "-n", "-l", "-P",
                                                "-p", f"{self.tmp}/{n['name']}.pid", "-r", f"{self.tmp}/{n['name']}.vrrp.pid"],
                                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))

    def ifaces(self, n): return [ifn for (node, ifn) in self.ifmap if node == n["name"]]

    def is_master(self, n):
        g = n["vrrp"][0]
        a = json.loads(l3.sh("ip", "-n", self.ns[n["name"]], "-j", "addr", "show", "dev", g["iface"]))
        return any(x.get("local") == g["ip"] for l in a for x in l.get("addr_info", []))

    def ping(self, src, dst):
        return subprocess.run(["ip", "netns", "exec", self.ns[src], "ping", "-c", "1", "-W", "2", dst], capture_output=True).returncode == 0

    def link(self, ref, up):
        node, ifn = ref.split(":")
        l3.sh("ip", "-n", self.ns[node], "link", "set", ifn, "up" if up else "down")

    def packets(self):
        for _, _, p in self.caps: p.terminate()
        for _, _, p in self.caps: p.wait()
        out = []
        for cable, f, _ in self.caps: out += [{**pkt, "cable": cable, "t": pkt["t"] - self.t0} for pkt in read_pcap(f) if pkt["t"] >= self.t0]
        return sorted(out, key=lambda p: p["t"])

    def close(self):
        subprocess.run(["pkill", "keepalived"], check=False)
        for _, _, p in self.caps: p.kill()
        super().close()
        shutil.rmtree(self.tmp, ignore_errors=True)


def kernel_run(name):
    spec = json.loads(netfile(name).read_text()); steps = json.loads((HERE / f"{name}.steps.json").read_text())
    k = VrrpNet(spec); out = []; clock = 0.0
    try:
        for s in steps:
            if "wait" in s:
                clock += s["wait"]; time.sleep(max(0.0, k.t0 + clock - time.time()))
            elif "linkDown" in s: k.link(s["linkDown"], False)
            elif "linkUp" in s: k.link(s["linkUp"], True)
            elif "snapshot" in s:
                e = {"t": time.time() - k.t0, "snapshot": s["snapshot"], "states": {n["name"]: "master" if k.is_master(n) else "not master" for n in k.talkers}}
                if s.get("ping"): e["ping"] = k.ping(*s["ping"])
                out.append(e)
        frames = k.packets()
    finally:
        k.close()
    return {"steps": out, "frames": frames}


def inner():
    l3.sh("mount", "-t", "tmpfs", "none", "/run")
    print(json.dumps({name: kernel_run(name) for name in sys.argv[2:] or SPECS}))


def race_replies(win, old_masters):
    """Linux frames to leave out of the gratuitous-ARP comparison: op 2 replies sent by a router that was master before this window
    (and is not any more), to the MAC of a router that announced itself in this window. They answer the new master's broadcast ARP
    in the sub-millisecond gap between that router hearing the new master's advert and removing the address (seen on R2 in
    vrrp-preempt "cable back", intermittently); the engine has no such gap. Anything else, unicast or not, still counts."""
    new_macs = {f["src"] for f in win if f.get("kind") == "arp" and f["dst"] == "ff:ff:ff:ff:ff:ff"}
    return [f for f in win if f.get("kind") == "arp" and f["op"] == 2 and f["dst"] in new_macs and f["cable"].split(":")[0] in old_masters]


ADVERT_KEYS = ("src", "dst", "vrid", "priority", "interval", "ttl")
ARP_KEYS = ("src", "dst", "op", "sha", "spa", "tha", "tpa")
def canon(f):
    if f.get("kind") == "arp":   # the router's own MAC differs per run (random on Linux): compare that the sender fields agree with each other
        d = {k: f[k] for k in ARP_KEYS if k not in ("src", "sha")}; d["sha is src"] = f["sha"] == f["src"]
        return json.dumps(d, sort_keys=True)
    return json.dumps({k: f[k] for k in ADVERT_KEYS}, sort_keys=True)


def phases(run):
    out, prev, fr = [], 0, run["frames"]
    for s in run["steps"]:
        n = s["frames"] if "frames" in s else sum(1 for p in fr if p["t"] <= s["t"])
        out.append((s, fr[prev:n])); prev = n
    return out


def per_cable(win):
    d = {}
    for f in win: d.setdefault(f["cable"], []).append(canon(f))
    return d


def aligned_counts(win, start, end):
    """Adverts per cable direction, counted from the first advert after `start` over a whole number of advert intervals that
    still ends before `end` (mid-interval), so both sides count the same span however the timers are phased."""
    out = {}
    for c in {f["cable"] for f in win}:
        fr = [f for f in win if f["cable"] == c]
        n = max(0, int((end - start) // fr[0]["interval"]) - 1)
        out[c] = sum(1 for f in fr if f["t"] < fr[0]["t"] + n * fr[0]["interval"])
    return out


def main():
    need = ["unshare", "ip", "tcpdump", "keepalived", "ping"]
    missing = [x for x in need if not shutil.which(x)]
    if os.geteuid() != 0 or missing:
        msg = f"Needs root, unshare, iproute2, tcpdump and keepalived (missing: {', '.join(missing) or 'root'})."
        if os.environ.get("GITHUB_ACTIONS"): print(msg); l3.gh_note("error", "VRRP validation cannot run", msg); return 1
        print(msg + " Skipping."); return 0
    names = sys.argv[1:] or SPECS
    kern = json.loads(subprocess.run(["unshare", "-n", "-m", sys.executable, __file__, "--inner", *names], check=True,
                                     capture_output=True, text=True, timeout=1800).stdout)
    rows, detail = [], {}
    for name in names:
        eng = json.loads(l3.sh("node", str(ROOT / "engine" / "tools" / "run_vrrp.mjs"), str(netfile(name)), str(HERE / f"{name}.steps.json")))
        kr = kern[name]
        pe, pk = phases(eng), phases(kr)
        assert len(pe) == len(pk), f"{name}: engine has {len(pe)} snapshots, keepalived run {len(pk)}"
        prev_t = 0.0; prev_masters = set()
        for (es, ewin), (ks, kwin) in zip(pe, pk):
            span = (prev_t, es["t"]); prev_t = es["t"]
            ef, kf = per_cable([f for f in ewin if f.get("kind") != "arp"]), per_cable([f for f in kwin if f.get("kind") != "arp"])
            skipped = race_replies(kwin, prev_masters)
            ea, ka = per_cable([f for f in ewin if f.get("kind") == "arp"]), per_cable([f for f in kwin if f.get("kind") == "arp" and f not in skipped])
            prev_masters = {n for n, st in ks["states"].items() if st == "master"}
            checks = {"master": es["states"] == ks["states"], "ping": es.get("ping") == ks.get("ping"),
                      "advertisements": {c: sorted(set(v)) for c, v in ef.items()} == {c: sorted(set(v)) for c, v in kf.items()},
                      "advert counts": aligned_counts([f for f in ewin if f.get("kind") != "arp"], *span) == aligned_counts([f for f in kwin if f.get("kind") != "arp"], *span),
                      "gratuitous ARP": {c: sorted(v) for c, v in ea.items()} == {c: sorted(v) for c, v in ka.items()}}
            ok = all(checks.values())
            master = ", ".join(n for n, s in es["states"].items() if s == "master") or "none"
            rows.append((name, es["snapshot"], master, f'{"✓" if es.get("ping") else "✗"}', ", ".join(f'{c} {"✓" if v else "✗"}' for c, v in checks.items()) +
                         f' · adverts {sum(len(v) for v in ef.values())} (Linux {sum(len(v) for v in kf.values())})' + (f' · Linux race replies left out: {len(skipped)}' if skipped else ''), "yes" if ok else "NO"))
            if not ok:
                detail[f'{name}: {es["snapshot"]}'] = {"engine": {"states": es["states"], "ping": es.get("ping"), "adverts": {c: [len(v), sorted(set(v))] for c, v in ef.items()}, "arp": {c: [len(v), sorted(set(v))] for c, v in ea.items()}},
                                                    "linux": {"race replies left out": len(skipped), "states": ks["states"], "ping": ks.get("ping"), "adverts": {c: [len(v), sorted(set(v))] for c, v in kf.items()}, "arp": {c: [len(v), sorted(set(v))] for c, v in ka.items()}}}
    md = ["| Network | Snapshot | Master (engine) | Host reaches virtual address | Checks | Match |", "|---|---|---|---|---|---|"]
    md += [f"| {a} | {b} | {c} | {d} | {e} | {f} |" for a, b, c, d, e, f in rows]
    (HERE / "results.md").write_text("\n".join(md) + "\n")
    (HERE / "mismatches.json").write_text(json.dumps(detail, indent=1))
    print("\n".join(md))
    l3.gh_note("notice", "VRRP results", "\n".join(md))
    if detail: print(json.dumps(detail, indent=1)[:8000]); l3.gh_note("error", "VRRP engine vs keepalived mismatch", json.dumps(detail))
    return 0 if not detail else 1


if __name__ == "__main__":
    if sys.argv[1:2] == ["--inner"]: inner()
    else:
        try: sys.exit(main())
        except (subprocess.CalledProcessError, RuntimeError) as e:
            l3.gh_note("error", "VRRP validation crashed", f"{e}\nstdout: {(getattr(e, 'stdout', '') or '')[-3000:]}\nstderr: {(getattr(e, 'stderr', '') or '')[-6000:]}")
            print((getattr(e, 'stderr', '') or str(e))[-6000:], file=sys.stderr)
            raise
