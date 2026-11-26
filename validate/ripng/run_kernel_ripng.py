#!/usr/bin/env python3
"""RIPng: the engine vs FRRouting ripngd in Linux namespaces, table by table and cable by cable.

    sudo python3 validate/ripng/run_kernel_ripng.py        # on a Mac: validate/docker/run.sh ripng

The same as validate/rip, for IPv6: the network is built like validate/ipv6 (Linux pinned to what the engine models: no duplicate
address detection, no router solicitations, MLD chatter dropped), every router with a `ripng` key runs zebra + ripngd configured from
the spec (`network`, `passive-interface`, `timers basic`, split horizon per interface), tcpdump records every RIPng packet sent out of
every interface, and the same steps (waits, cable cuts, pings) run in the engine (engine/tools/run_ripng.mjs).

Link-local addresses come from MACs, which Linux picks at random, so every fe80:: address (packet sources, next hops) is replaced by
the name of the interface it belongs to ("R2:eth0") in both runs before comparing. Compared at every snapshot: the RIPng table of
every router (type, prefix, next hop, metric); the last periodic update on every cable (source, destination, hop limit, command,
version and every entry in order); which prefixes were newly advertised with metric 16 since the previous snapshot, and which cables
carried a Request; ping results. Not compared: exact send times (FRR's timers are randomized).
"""
import ipaddress, json, os, re, shutil, struct, subprocess, sys, tempfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "validate" / "l3")); sys.path.insert(0, str(ROOT / "validate" / "ipv6"))
import run_kernel_l3 as l3  # noqa: E402
import run_kernel_ipv6 as v6  # noqa: E402

SPECS = ["ripng-chain"]
FRR = "/usr/lib/frr"
DEFAULT_TIMERS = {"update": 30, "timeout": 180, "garbage": 120}
SPLIT = {"simple": " ipv6 ripng split-horizon", "poisoned": " ipv6 ripng split-horizon poisoned-reverse", "off": " no ipv6 ripng split-horizon"}
GROUP = "ff02::9"


def ip6(b): return ipaddress.IPv6Address(bytes(b)).compressed


class RipNgNet(v6.Net6):
    def __init__(self, spec):
        super().__init__(spec)
        self.tmp2 = tempfile.mkdtemp(); os.chmod(self.tmp2, 0o755); self.rcaps = []; self.frr = {}
        # A pulled cable in the engine keeps the addresses; `ip link set down` would delete them (and with them the connected routes),
        # so keep addresses on down: the link-down / link-up steps then model only the carrier, like the IPv4 RIP validator.
        for (node, ifn) in self.ifmap: l3.sysctl(self.ns[node], f"net.ipv6.conf.{ifn}.keep_addr_on_down", 1)
        for (node, ifn), peer in sorted(self.ifmap.items()):
            f = f"{self.tmp2}/{node}-{ifn}.pcap"
            p = subprocess.Popen(["ip", "netns", "exec", self.ns[node], "tcpdump", "-i", ifn, "-Q", "out", "-U", "-n", "-s", "0",
                                  "-Z", "root", "-w", f, "udp port 521"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.rcaps.append((f"{node}:{ifn}>{peer}", f, p))
        time.sleep(1.5)
        routers = [n for n in spec["nodes"] if n.get("ripng")]
        for n in routers: self.frr[n["name"]] = self.write_conf(n)
        for n in routers:
            d = self.frr[n["name"]]; c = self.conf_dir(n["name"])
            self.procs.append(subprocess.Popen(["ip", "netns", "exec", self.ns[n["name"]], f"{FRR}/zebra", "-f", f"{c}/zebra.conf", "-i", f"{d}/zebra.pid",
                                                "-z", f"{d}/zserv.api", "--vty_socket", d, "-P", "0"],
                                               stdout=open(f"{self.tmp2}/zebra-{n['name']}.log", "w"), stderr=subprocess.STDOUT))
        time.sleep(2)
        for n in routers:
            d = self.frr[n["name"]]
            self.procs.append(subprocess.Popen(["ip", "netns", "exec", self.ns[n["name"]], f"{FRR}/ripngd", "-i", f"{d}/ripngd.pid",
                                                "-z", f"{d}/zserv.api", "--vty_socket", d, "-P", "0"],
                                               stdout=open(f"{self.tmp2}/ripngd-{n['name']}.log", "w"), stderr=subprocess.STDOUT))
        time.sleep(1)
        for n in routers:   # ripngd has no -f in newer FRR: load the config through vtysh
            d = self.frr[n["name"]]; c = self.conf_dir(n["name"])
            r = subprocess.run(["ip", "netns", "exec", self.ns[n["name"]], "vtysh", "--vty_socket", d, "-f", f"{c}/ripngd.conf"], capture_output=True, text=True)
            if r.returncode: raise RuntimeError(f"vtysh -f failed on {n['name']}: {r.stdout[-800:]}{r.stderr[-800:]}")
        self.t0 = time.time()
        self.ll = self.link_locals()

    def link_locals(self):
        """{fe80 address: "node:iface"} for every interface."""
        out = {}
        for (node, ifn) in self.ifmap:
            if next(n for n in self.spec["nodes"] if n["name"] == node)["kind"] == "switch": continue
            for a in json.loads(l3.nsx(self.ns[node], "ip", "-j", "-6", "addr", "show", "dev", ifn, "scope", "link") or "[]"):
                for i in a.get("addr_info", []):
                    addr = i.get("local") or i.get("address")
                    if addr and addr.lower().startswith("fe80"): out[ipaddress.IPv6Address(addr).compressed] = f"{node}:{ifn}"
        return out

    def conf_dir(self, name): return f"{self.tmp2}/frr-{name}"

    def write_conf(self, n):
        d = self.conf_dir(n["name"]); os.makedirs(d)
        r = n["ripng"]; t = {**DEFAULT_TIMERS, **(r.get("timers") or {})}
        conf = [f"hostname {n['name']}"]
        for ifn in n["ifaces6"]: conf += [f"interface {ifn}", SPLIT[r.get("splitHorizon", "simple")], "!"]
        conf += ["router ripng", f" timers basic {t['update']} {t['timeout']} {t['garbage']}"]
        conf += [f" network {x}" for x in r["networks"]] + [f" passive-interface {x}" for x in r.get("passive", [])] + ["!"]
        Path(f"{d}/ripngd.conf").write_text("\n".join(conf) + "\n")
        Path(f"{d}/zebra.conf").write_text(f"hostname {n['name']}\n")
        shutil.chown(d, "frr", "frr")
        for f in os.listdir(d): shutil.chown(f"{d}/{f}", "frr", "frr"); os.chmod(f"{d}/{f}", 0o666)
        os.chmod(d, 0o777)
        os.makedirs("/run/frr", exist_ok=True); shutil.chown("/run/frr", "frr", "frr"); os.chmod("/run/frr", 0o775)
        rd = f"/run/frr/opr-{os.path.basename(self.tmp2)}-{n['name']}"; os.makedirs(rd, exist_ok=True)
        shutil.chown(rd, "frr", "frr"); os.chmod(rd, 0o775)
        return rd

    def tables(self):
        out = {}
        for name, d in self.frr.items():
            r = subprocess.run(["ip", "netns", "exec", self.ns[name], "vtysh", "--vty_socket", d, "-c", "show ipv6 ripng"], capture_output=True, text=True)
            if r.returncode:
                logs = "".join(f"\n--- {f}\n" + Path(f"{self.tmp2}/{f}").read_text()[-1500:] for f in sorted(os.listdir(self.tmp2)) if f.endswith(".log"))
                raise RuntimeError(f"vtysh failed ({r.returncode}) on {name}: {r.stderr[-1500:]}{r.stdout[-500:]}{logs}")
            rows = []; lines = r.stdout.splitlines()
            for k, line in enumerate(lines):
                m = re.match(r"^([CR])\(\w\)\s+(\S+)\s*(.*)$", line)
                if not m: continue
                tok = m[3].split() or (lines[k + 1].split() if k + 1 < len(lines) else [])
                if len(tok) < 3: continue
                rows.append({"network": m[2], "nextHop": tok[0], "metric": int(tok[2]), "type": m[1]})
            out[name] = rows
        return out

    def link(self, ref, up):
        node, ifn = ref.split(":")
        l3.sh("ip", "-n", self.ns[node], "link", "set", ifn, "up" if up else "down")

    def close(self):
        for _, _, p in self.rcaps: p.kill()
        super().close()
        for d in self.frr.values(): shutil.rmtree(d, ignore_errors=True)

    def packets(self):
        for _, _, p in self.rcaps: p.terminate()
        for _, _, p in self.rcaps: p.wait()
        out = []
        for cable, f, _ in self.rcaps: out += [{**pkt, "cable": cable, "t": pkt["t"] - self.t0} for pkt in read_pcap(f)]
        return sorted(out, key=lambda p: p["t"])


def read_pcap(path):
    data = Path(path).read_bytes() if Path(path).exists() else b""
    if len(data) < 24: return []
    magic = struct.unpack("<I", data[:4])[0]
    e = "<" if magic in (0xa1b2c3d4, 0xa1b23c4d) else ">"
    scale = 1e-9 if magic in (0xa1b23c4d, 0x4d3cb2a1) else 1e-6
    off, out = 24, []
    while off + 16 <= len(data):
        sec, frac, incl, _ = struct.unpack(e + "IIII", data[off:off + 16]); off += 16
        frame = data[off:off + incl]; off += incl
        if len(frame) < 62 or frame[12:14] != b"\x86\xdd" or frame[20] != 17: continue
        ip = frame[14:]; udp = ip[40:]; sport, dport = struct.unpack("!HH", udp[:4]); rip = udp[8:]
        entries = []
        for k in range(4, len(rip) - 19, 20):
            entries.append({"prefix": ip6(rip[k:k + 16]), "len": rip[k + 18], "metric": rip[k + 19], "tag": struct.unpack("!H", rip[k + 16:k + 18])[0]})
        out.append({"t": sec + frac * scale, "src": ip6(ip[8:24]), "dst": ip6(ip[24:40]), "hl": ip[7], "sport": sport, "dport": dport,
                    "command": {1: "request", 2: "response"}.get(rip[0], rip[0]), "version": rip[1], "entries": entries})
    return out


def kernel_run(name):
    spec = json.loads((HERE / f"{name}.json").read_text()); steps = json.loads((HERE / f"{name}.steps.json").read_text())
    k = RipNgNet(spec); out = []; clock = 0.0
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
        packets = k.packets(); ll = k.ll
    finally:
        k.close()
    return {"steps": out, "packets": packets, "ll": ll}


def inner():
    l3.sh("mount", "-t", "tmpfs", "none", "/run")
    print(json.dumps({name: kernel_run(name) for name in sys.argv[2:] or SPECS}))


# ----- comparison -----
def norm(run):
    """Replace every link-local address by its interface's name, in packets and tables."""
    ll = run["ll"]; f = lambda a: ll.get(a, a)
    for p in run["packets"]: p["src"] = f(p["src"]); p["dst"] = f(p["dst"])
    for s in run["steps"]:
        for rows in s.get("tables", {}).values():
            for r in rows: r["nextHop"] = f(r["nextHop"])
    return run


def msg(p):
    return {"src": p["src"], "dst": p["dst"], "hl": p["hl"], "command": p["command"], "version": p["version"],
            "entries": [{k: e[k] for k in ("prefix", "len", "metric", "tag")} for e in p["entries"] if e["metric"] != 255]}   # metric 255 = next-hop RTE (RFC 2080 2.1.1), not a route


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
    """Per (cable, source): what that router's updates say about each network, most recent mention wins. A single update is
    not comparable: FRR sends triggered updates (changed routes only) and periodic ones at random times, so which kind is
    last before a snapshot is chance. The cumulative view is what a neighbour has learned."""
    last = {}
    for p in pkts:
        if p["command"] == "response" and p["dst"] == GROUP:
            st = last.setdefault(f'{p["cable"]} from {p["src"]}', {})   # a switch port carries several routers' updates
            for e in msg(p)["entries"]: st[f'{e["prefix"]}/{e["len"]}'] = e["metric"]
    return last


def poisoned_before(before):
    """Per (cable, source): the networks whose most recent mention in a response was metric 16. Walks every response, not only
    the last one: a triggered update lists just the routes that changed, so which update happens to be the last one before a
    snapshot depends on FRR's random timers (ripngd's 1-5 s triggered-update delay, ±update/4 periodic jitter)."""
    state = {}
    for p in before:
        if p["command"] != "response": continue
        st = state.setdefault(f'{p["cable"]} from {p["src"]}', {})
        for e in p["entries"]: st[f'{e["prefix"]}/{e["len"]}'] = e["metric"]
    return {k: {n for n, m in st.items() if m == 16} for k, st in state.items()}


def views(win, upto, before):
    """before: packets up to the previous snapshot. Metric-16 routes count only when newly poisoned: not already at 16 the last
    time that router mentioned them on that cable (poisoned reverse repeats in every periodic update, whose timing is random)."""
    old = poisoned_before(before)
    poisoned, requests, updates = {}, set(), {}
    for p in win:
        if p["command"] == "request": requests.add(p["cable"])
        if p["command"] == "response":
            if p["dst"] == GROUP: updates[p["cable"]] = updates.get(p["cable"], 0) + 1
            for e in p["entries"]:
                net = f'{e["prefix"]}/{e["len"]}'
                if e["metric"] == 16 and net not in old.get(f'{p["cable"]} from {p["src"]}', set()): poisoned.setdefault(p["cable"], set()).add(net)
    return last_updates(upto), {k: sorted(v) for k, v in poisoned.items()}, sorted(requests), updates


def table_text(rows):
    return ", ".join(f'{r["type"]} {r["network"]}' + (f' via {r["nextHop"]}' if r["type"] == "R" else "") + f' m{r["metric"]}' for r in rows)


def main():
    need = ["unshare", "ip", "tcpdump", "nft", "vtysh", f"{FRR}/ripngd", f"{FRR}/zebra"]
    if os.geteuid() != 0 or not all(shutil.which(x) or os.path.exists(x) for x in need):
        print("Needs root, unshare, iproute2, tcpdump, nftables and FRRouting (zebra, ripngd, vtysh).")
        if os.environ.get("GITHUB_ACTIONS"): print("This check is required in CI: failing instead of skipping."); return 1
        print("Skipping."); return 0
    names = sys.argv[1:] or SPECS
    kern = json.loads(subprocess.run(["unshare", "-n", "-m", sys.executable, __file__, "--inner", *names], check=True,
                                     capture_output=True, text=True, timeout=1200).stdout)
    if os.environ.get('RIPNG_DUMP'): Path(os.environ['RIPNG_DUMP']).write_text(json.dumps(kern))
    rows, detail = [], {}
    for name in names:
        steps_spec = json.loads((HERE / f"{name}.steps.json").read_text())
        eng = json.loads(l3.sh("node", str(ROOT / "engine" / "tools" / "run_ripng.mjs"), str(HERE / f"{name}.json"), str(HERE / f"{name}.steps.json")))
        eng = norm(eng); kr = norm(kern[name])
        assert len(eng["steps"]) == len(kr["steps"]), f"{name}: engine ran {len(eng['steps'])} steps, Linux {len(kr['steps'])}"
        for i, ((es, want, ewin, eupto), (ks, _, kwin, kupto)) in enumerate(zip(phases(eng, steps_spec), phases(kr, steps_spec))):
            el, ep, ereq, eupd = views(ewin, eupto, eupto[:len(eupto) - len(ewin)]); kl, kp, kreq, kupd = views(kwin, kupto, kupto[:len(kupto) - len(kwin)])
            srt = lambda rows: sorted(rows, key=lambda x: x["network"])
            et = {r: srt([{k: x[k] for k in ("type", "network", "nextHop", "metric")} for x in t]) for r, t in es["tables"].items()}
            kt = {r: srt(t) for r, t in ks["tables"].items()}
            checks = {"tables": et == kt}
            if want: checks["last update on every cable"] = el == kl
            if i > 0: checks["newly poisoned routes on every cable"] = ep == kp; checks["requests"] = ereq == kreq
            ok = all(checks.values())
            upd = f'{sum(eupd.values())} updates (Linux {sum(kupd.values())})'
            rows.append((name, es["snapshot"], "; ".join(f'{r}: {table_text(t)}' for r, t in et.items()),
                         ", ".join(f'{c} {"✓" if v else "✗"}' for c, v in checks.items()) + f" · {upd}", "✓" if ok else "✗"))
            if not ok:
                d = {}
                if not checks["tables"]: d["tables"] = {"engine": et, "linux": kt}
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
    if detail: print(json.dumps(detail, indent=1)[:6000]); l3.gh_note("error", "RIPng engine vs FRR mismatch", json.dumps(detail))
    return 0 if not detail else 1


if __name__ == "__main__":
    if sys.argv[1:2] == ["--inner"]: inner()
    else:
        try: sys.exit(main())
        except (subprocess.CalledProcessError, RuntimeError) as e:
            l3.gh_note("error", "RIPng validation crashed", f"{e}\nstdout: {(getattr(e, 'stdout', '') or '')[-3000:]}\nstderr: {(getattr(e, 'stderr', '') or '')[-6000:]}")
            print((getattr(e, 'stderr', '') or str(e))[-6000:], file=sys.stderr)
            raise
