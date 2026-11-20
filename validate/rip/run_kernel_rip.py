#!/usr/bin/env python3
"""RIPv2: the engine vs FRRouting ripd in Linux namespaces, table by table and cable by cable.

    sudo python3 validate/rip/run_kernel_rip.py        # on a Mac: validate/docker/run.sh rip

Builds each spec from network namespaces like validate/l3 (it reuses that harness). Every router with a
`rip` key runs its own zebra + ripd (FRRouting), configured from the spec: `network`, `passive-interface`,
`timers basic`, and the split-horizon mode on every interface. tcpdump records every RIP packet sent out
of every interface. The same steps (waits, cable cuts, pings) run in the engine (engine/tools/run_rip.mjs).

Compared at every snapshot:
  - the RIP table of every router (`show ip rip`: type, network, next hop, metric);
  - the last periodic update from every router on every cable direction: source, destination, TTL, command, version and
    every route entry (network, mask, next hop, metric, tag), in order; and which cables carry updates;
  - since the previous snapshot: on every cable direction, which networks were newly advertised with metric 16
    (carrier loss, timeouts; not the poisoned-reverse entries every update repeats), and which cables carried a Request;
  - ping results at the steps that ask for one.
Not compared: exact send times. FRR moves every periodic update by up to ±update/4 at random and waits a
random 1-5 s between triggered updates; the engine is exact. The number of updates per cable is listed.
"""
import json, os, re, shutil, struct, subprocess, sys, tempfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "validate" / "l3"))
import run_kernel_l3 as l3  # noqa: E402

SPECS = ["rip-chain", "rip-lan", "rip-nosplit"]
FRR = "/usr/lib/frr"
DEFAULT_TIMERS = {"update": 30, "timeout": 180, "garbage": 120}
SPLIT = {"simple": " ip rip split-horizon", "poisoned": " ip rip split-horizon poisoned-reverse", "off": " no ip rip split-horizon"}


class RipNet(l3.KernelNet):
    def __init__(self, spec):
        super().__init__(spec)
        self.tmp = tempfile.mkdtemp(); os.chmod(self.tmp, 0o755); self.caps = []; self.frr = {}
        for (node, ifn), peer in sorted(self.ifmap.items()):
            f = f"{self.tmp}/{node}-{ifn}.pcap"
            p = subprocess.Popen(["ip", "netns", "exec", self.ns[node], "tcpdump", "-i", ifn, "-Q", "out", "-U", "-n", "-s", "0",
                                  "-Z", "root", "-w", f, "udp port 520"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.caps.append((f"{node}:{ifn}>{peer}", f, p))
        time.sleep(1.5)
        routers = [n for n in spec["nodes"] if n.get("rip")]
        for n in routers: self.frr[n["name"]] = self.write_conf(n)
        for n in routers:
            d = self.frr[n["name"]]; c = self.conf_dir(n["name"])
            self.procs.append(subprocess.Popen(["ip", "netns", "exec", self.ns[n["name"]], f"{FRR}/zebra", "-f", f"{c}/zebra.conf", "-i", f"{d}/zebra.pid",
                                                "-z", f"{d}/zserv.api", "--vty_socket", d, "-P", "0"],
                                               stdout=open(f"{self.tmp}/zebra-{n['name']}.log", "w"), stderr=subprocess.STDOUT))
        time.sleep(2)
        self.t0 = time.time()
        for n in routers:
            d = self.frr[n["name"]]
            self.procs.append(subprocess.Popen(["ip", "netns", "exec", self.ns[n["name"]], f"{FRR}/ripd", "-i", f"{d}/ripd.pid",
                                                "-z", f"{d}/zserv.api", "--vty_socket", d, "-P", "0"],
                                               stdout=open(f"{self.tmp}/ripd-{n['name']}.log", "w"), stderr=subprocess.STDOUT))
        time.sleep(1)
        for n in routers:   # newer FRR's ripd has no -f: load the config through vtysh (works on older FRR too)
            d = self.frr[n["name"]]; c = self.conf_dir(n["name"])
            r = subprocess.run(["ip", "netns", "exec", self.ns[n["name"]], "vtysh", "--vty_socket", d, "-f", f"{c}/ripd.conf"], capture_output=True, text=True)
            if r.returncode: raise RuntimeError(f"vtysh -f failed on {n['name']}: {r.stdout[-800:]}{r.stderr[-800:]}")
        self.t0 = time.time()

    def conf_dir(self, name): return f"{self.tmp}/frr-{name}"

    def write_conf(self, n):
        """Config files go in a temp dir; every runtime path (pid files, zserv.api, vty sockets) goes in a per-router dir
        under /run/frr, the only place a host AppArmor profile confining the FRR daemons lets them write. Returns the latter."""
        d = self.conf_dir(n["name"]); os.makedirs(d)
        r = n["rip"]; t = {**DEFAULT_TIMERS, **(r.get("timers") or {})}
        conf = [f"hostname {n['name']}"]
        for ifn in n["ifaces"]: conf += [f"interface {ifn}", SPLIT[r.get("splitHorizon", "simple")], "!"]
        conf += ["router rip", " version 2", f" timers basic {t['update']} {t['timeout']} {t['garbage']}"]
        conf += [f" network {x}" for x in r["networks"]] + [f" passive-interface {x}" for x in r.get("passive", [])] + ["!"]
        Path(f"{d}/ripd.conf").write_text("\n".join(conf) + "\n")
        Path(f"{d}/zebra.conf").write_text(f"hostname {n['name']}\n")
        shutil.chown(d, "frr", "frr")   # the daemons run as their usual user "frr" (root isn't in the frrvty group)
        for f in os.listdir(d): shutil.chown(f"{d}/{f}", "frr", "frr"); os.chmod(f"{d}/{f}", 0o666)
        os.chmod(d, 0o777)
        os.makedirs("/run/frr", exist_ok=True); shutil.chown("/run/frr", "frr", "frr"); os.chmod("/run/frr", 0o775)
        rd = f"/run/frr/opr-{os.path.basename(self.tmp)}-{n['name']}"; os.makedirs(rd, exist_ok=True)
        shutil.chown(rd, "frr", "frr"); os.chmod(rd, 0o775)
        return rd

    def tables(self):
        out = {}
        for name, d in self.frr.items():
            r = subprocess.run(["ip", "netns", "exec", self.ns[name], "vtysh", "--vty_socket", d, "-c", "show ip rip"], capture_output=True, text=True)
            if r.returncode:
                logs = "".join(f"\n--- {f}\n" + Path(f"{self.tmp}/{f}").read_text()[-1500:] for f in sorted(os.listdir(self.tmp)) if f.endswith(".log"))
                raise RuntimeError(f"vtysh failed ({r.returncode}) on {name}: {r.stderr[-1500:]}{r.stdout[-500:]}\n{subprocess.run(['ls', '-la', d], capture_output=True, text=True).stdout}\n"
                                   f"{subprocess.run(['ps', 'aux'], capture_output=True, text=True).stdout[-1500:]}{logs}")
            txt = r.stdout; rows = []
            for line in txt.splitlines():
                m = re.match(r"^([CR])\(\w\)\s+(\S+)\s+(\S+)\s+(\d+)\s", line)
                if m: rows.append({"network": m[2], "nextHop": m[3], "metric": int(m[4]), "type": m[1]})
            out[name] = rows
        return out

    def link(self, ref, up):
        node, ifn = ref.split(":")
        l3.sh("ip", "-n", self.ns[node], "link", "set", ifn, "up" if up else "down")

    def close(self):
        for _, _, p in self.caps: p.kill()
        super().close()
        for d in self.frr.values(): shutil.rmtree(d, ignore_errors=True)

    def packets(self):
        for _, _, p in self.caps: p.terminate()
        for _, _, p in self.caps: p.wait()
        out = []
        for cable, f, _ in self.caps: out += [{**pkt, "cable": cable, "t": pkt["t"] - self.t0} for pkt in read_pcap(f)]
        return sorted(out, key=lambda p: p["t"])


def ip4(b): return ".".join(str(x) for x in b)


def read_pcap(path):
    data = Path(path).read_bytes() if Path(path).exists() else b""
    if len(data) < 24: return []
    magic = struct.unpack("<I", data[:4])[0]
    e, scale = ("<", 1e-6) if magic in (0xa1b2c3d4, 0xa1b23c4d) else (">", 1e-6)
    if magic in (0xa1b23c4d, 0x4d3cb2a1): scale = 1e-9
    off, out = 24, []
    while off + 16 <= len(data):
        sec, frac, incl, _ = struct.unpack(e + "IIII", data[off:off + 16]); off += 16
        frame = data[off:off + incl]; off += incl
        if len(frame) < 14 or frame[12:14] != b"\x08\x00": continue
        ip = frame[14:]; ihl = (ip[0] & 15) * 4
        if ip[9] != 17: continue
        udp = ip[ihl:]; sport, dport = struct.unpack("!HH", udp[:4]); rip = udp[8:]
        entries = []
        for k in range(4, len(rip) - 19, 20):
            fam, tag = struct.unpack("!HH", rip[k:k + 4])
            entries.append({"family": fam, "net": ip4(rip[k + 4:k + 8]), "mask": ip4(rip[k + 8:k + 12]), "nextHop": ip4(rip[k + 12:k + 16]),
                            "metric": struct.unpack("!I", rip[k + 16:k + 20])[0], "tag": tag})
        out.append({"t": sec + frac * scale, "src": ip4(ip[12:16]), "dst": ip4(ip[16:20]), "ttl": ip[8], "sport": sport, "dport": dport,
                    "command": {1: "request", 2: "response"}.get(rip[0], rip[0]), "version": rip[1], "entries": entries})
    return out


def kernel_run(name):
    spec = json.loads((HERE / f"{name}.json").read_text()); steps = json.loads((HERE / f"{name}.steps.json").read_text())
    k = RipNet(spec); out = []; clock = 0.0
    try:
        for s in steps:
            if "wait" in s:
                clock += s["wait"]; time.sleep(max(0.0, k.t0 + clock - time.time()))
            elif "linkDown" in s: k.link(s["linkDown"], False)
            elif "linkUp" in s: k.link(s["linkUp"], True)
            elif "ping" in s:
                k.flush(); r = k.act({"do": "ping", "src": s["ping"][0], "dst": s["ping"][1], "timeout": 2})
                out.append({"t": time.time() - k.t0, "ping": s["ping"], "result": r}); clock = max(clock, time.time() - k.t0)
            elif "snapshot" in s:
                out.append({"t": time.time() - k.t0, "snapshot": s["snapshot"], "tables": k.tables()})
        packets = k.packets()
    finally:
        k.close()
    return {"steps": out, "packets": packets}


def inner():
    l3.sh("mount", "-t", "tmpfs", "none", "/run")
    print(json.dumps({name: kernel_run(name) for name in sys.argv[2:] or SPECS}))


# ----- comparison -----
def msg(p):
    return {"src": p["src"], "dst": p["dst"], "ttl": p["ttl"], "command": p["command"], "version": p["version"],
            "entries": [{k: e[k] for k in ("net", "mask", "nextHop", "metric", "tag")} for e in p["entries"]]}


def phases(run, steps_spec):
    """Per snapshot: (snapshot, lastUpdate wanted, packets since the previous snapshot, packets before it)."""
    snaps = [s for s in run["steps"] if "snapshot" in s]
    wants = [s.get("lastUpdate", True) for s in steps_spec if "snapshot" in s]
    out, prev, pk = [], 0, run["packets"]
    for s, w in zip(snaps, wants):
        # the engine says how many packets came before the snapshot (a cable restored right after it acts at the same instant)
        n = s["packets"] if "packets" in s else sum(1 for p in pk if p["t"] <= s["t"])
        out.append((s, w, pk[prev:n], pk[:n]))
        prev = n
    return out


def last_updates(pkts):
    last = {}
    for p in pkts:
        if p["command"] == "response" and p["dst"] == "224.0.0.9": last[f'{p["cable"]} from {p["src"]}'] = msg(p)   # a switch port carries several routers' updates
    return last


def poisoned_before(before):
    """Per (cable, source): the networks whose most recent mention in a response was metric 16. Walks every response, not only
    the last one: a triggered update lists just the routes that changed, so which update happens to be the last one before a
    snapshot depends on FRR's random timers (ripd's 1-5 s triggered-update delay, ±update/4 periodic jitter)."""
    state = {}
    for p in before:
        if p["command"] != "response": continue
        st = state.setdefault(f'{p["cable"]} from {p["src"]}', {})
        for e in p["entries"]: st[f'{e["net"]}/{e["mask"]}'] = e["metric"]
    return {k: {n for n, m in st.items() if m == 16} for k, st in state.items()}


def views(win, upto, before):
    """before: packets up to the previous snapshot. Metric-16 routes count only when newly poisoned: not already at 16 the last
    time that router mentioned them on that cable (poisoned reverse repeats in every periodic update, whose timing is random)."""
    old = poisoned_before(before)
    poisoned, requests, updates = {}, set(), {}
    for p in win:
        if p["command"] == "request": requests.add(p["cable"])
        if p["command"] == "response":
            if p["dst"] == "224.0.0.9": updates[p["cable"]] = updates.get(p["cable"], 0) + 1
            for e in p["entries"]:
                net = f'{e["net"]}/{e["mask"]}'
                if e["metric"] == 16 and net not in old.get(f'{p["cable"]} from {p["src"]}', set()): poisoned.setdefault(p["cable"], set()).add(net)
    return last_updates(upto), {k: sorted(v) for k, v in poisoned.items()}, sorted(requests), updates


def table_text(rows):
    return ", ".join(f'{r["type"]} {r["network"]}' + (f' via {r["nextHop"]}' if r["type"] == "R" else "") + f' m{r["metric"]}' for r in rows)


def main():
    need = ["unshare", "ip", "tcpdump", "vtysh", f"{FRR}/ripd", f"{FRR}/zebra"]
    if os.geteuid() != 0 or not all(shutil.which(x) or os.path.exists(x) for x in need):
        print(f"Needs root, unshare, iproute2, tcpdump and FRRouting (zebra, ripd, vtysh). Skipping."); return 0
    names = sys.argv[1:] or SPECS
    kern = json.loads(subprocess.run(["unshare", "-n", "-m", sys.executable, __file__, "--inner", *names], check=True,
                                     capture_output=True, text=True, timeout=1200).stdout)
    if os.environ.get('RIP_DUMP'): Path(os.environ['RIP_DUMP']).write_text(json.dumps(kern))
    rows, detail = [], {}
    for name in names:
        steps_spec = json.loads((HERE / f"{name}.steps.json").read_text())
        eng = json.loads(l3.sh("node", str(ROOT / "engine" / "tools" / "run_rip.mjs"), str(HERE / f"{name}.json"), str(HERE / f"{name}.steps.json")))
        kr = kern[name]
        for i, ((es, want, ewin, eupto), (ks, _, kwin, kupto)) in enumerate(zip(phases(eng, steps_spec), phases(kr, steps_spec))):
            el, ep, ereq, eupd = views(ewin, eupto, eupto[:len(eupto) - len(ewin)]); kl, kp, kreq, kupd = views(kwin, kupto, kupto[:len(kupto) - len(kwin)])
            et = {r: [{k: x[k] for k in ("type", "network", "nextHop", "metric")} for x in t] for r, t in es["tables"].items()}
            checks = {"tables": et == ks["tables"]}
            if want: checks["last update on every cable"] = el == kl
            if i > 0: checks["newly poisoned routes on every cable"] = ep == kp; checks["requests"] = ereq == kreq
            ok = all(checks.values())
            upd = f'{sum(eupd.values())} updates (Linux {sum(kupd.values())})'
            rows.append((name, es["snapshot"], "; ".join(f'{r}: {table_text(t)}' for r, t in et.items()),
                         ", ".join(f'{c} {"✓" if v else "✗"}' for c, v in checks.items()) + f" · {upd}", "✓" if ok else "✗"))
            if not ok:
                d = {}
                if not checks["tables"]: d["tables"] = {"engine": et, "linux": ks["tables"]}
                if not checks.get("last update on every cable", True):
                    d["last update"] = {c: {"engine": el.get(c), "linux": kl.get(c)} for c in sorted(set(el) | set(kl)) if el.get(c) != kl.get(c)}
                if not checks.get("newly poisoned routes on every cable", True):
                    d["metric 16"] = {c: {"engine": ep.get(c), "linux": kp.get(c)} for c in sorted(set(ep) | set(kp)) if ep.get(c) != kp.get(c)}
                if not checks.get("requests", True): d["requests"] = {"engine": ereq, "linux": kreq}
                detail[f'{name}: {es["snapshot"]}'] = d
        for ep_, kp_ in zip([s for s in eng["steps"] if "ping" in s], [s for s in kr["steps"] if "ping" in s]):
            e, k = l3.comparable(ep_["result"]), l3.comparable(kp_["result"]); ok = e == k
            what = f'ping {ep_["ping"][0]} → {ep_["ping"][1]} at {ep_["t"]:.0f} s'
            rows.append((name, what, ("ok" if e.get("ok") else e.get("error", "?")) + (f' from {e["from"]}' if e.get("from") else ""), "result", "✓" if ok else "✗"))
            if not ok: detail[f"{name}: {what}"] = {"engine": e, "linux": k}
    md = ["| Network | Snapshot | Engine RIP tables (same in FRR?) | Checks | Match |", "|---|---|---|---|---|"]
    md += [f"| {a} | {b} | {c} | {d} | {e} |" for a, b, c, d, e in rows]
    (HERE / "results.md").write_text("\n".join(md) + "\n")
    (HERE / "mismatches.json").write_text(json.dumps(detail, indent=1))
    print("\n".join(md))
    if detail: print(json.dumps(detail, indent=1)[:6000]); l3.gh_note("error", "RIP engine vs FRR mismatch", json.dumps(detail))
    return 0 if not detail else 1


if __name__ == "__main__":
    if sys.argv[1:2] == ["--inner"]: inner()
    else:
        try: sys.exit(main())
        except (subprocess.CalledProcessError, RuntimeError) as e:
            l3.gh_note("error", "RIP validation crashed", f"{e}\nstdout: {(getattr(e, 'stdout', '') or '')[-3000:]}\nstderr: {(getattr(e, 'stderr', '') or '')[-6000:]}")
            print((getattr(e, 'stderr', '') or str(e))[-6000:], file=sys.stderr)
            raise
