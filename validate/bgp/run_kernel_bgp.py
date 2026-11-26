#!/usr/bin/env python3
"""BGP-4: the engine vs FRRouting bgpd in Linux namespaces: sessions, best paths, routes in the kernel and the messages on every cable.

    sudo python3 validate/bgp/run_kernel_bgp.py        # on a Mac: validate/docker/run.sh bgp

Builds each spec from network namespaces like validate/l3 (it reuses that harness). Every router with a `bgp` key runs
its own zebra + bgpd (FRRouting), configured from the spec: AS number, router ID, neighbors (remote AS, next-hop-self,
a local preference of 200 on what the neighbor sends, timers), `network` statements. tcpdump records every BGP message
sent out of every interface. The same steps (waits, cable cuts, pings) run in the engine (engine/tools/run_bgp.mjs).

Compared at every snapshot, for every router:
  - the sessions: neighbor address, remote AS, whether Established and the neighbor's router ID;
  - the BGP table: for every prefix every path with where it came from, whether it is valid and best, next hop, AS path,
    origin and local preference;
  - the routes bgpd put in the kernel: prefix, next hop, interface;
  - what every router has told every neighbor: per cable direction the prefixes announced (their AS path, next hop and
    origin as last sent) and not withdrawn since;
  - which message types other than KEEPALIVE crossed every cable direction since the previous snapshot;
  - ping results at the steps that ask for one.
Not compared: exact times, how many UPDATEs carry the prefixes, KEEPALIVE counts, MED and everything else the engine does not model.
"""
import json, os, shutil, struct, subprocess, sys, tempfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "validate" / "l3"))
import run_kernel_l3 as l3  # noqa: E402

SPECS = ["bgp-chain", "bgp-ibgp", "bgp-paths", "bgp-localpref"]
FRR = "/usr/lib/frr"
MSG = {1: "open", 2: "update", 3: "notification", 4: "keepalive"}
ORIGINS = {1: "igp", 2: "egp", 3: "incomplete", 0: "igp"}


def netfile(name): return HERE / f"{name}.net"      # .net, not .json: the CLI round-trip test reads every *.json spec
def ip4(b): return ".".join(str(x) for x in b)
def ip2int(s): return struct.unpack("!I", bytes(int(x) for x in s.split(".")))[0]


class BgpNet(l3.KernelNet):
    def __init__(self, spec):
        super().__init__(spec)
        self.tmp = tempfile.mkdtemp(); os.chmod(self.tmp, 0o755); self.caps = []; self.frr = {}
        for (node, ifn), peer in sorted(self.ifmap.items()):
            f = f"{self.tmp}/{node}-{ifn}.pcap"
            p = subprocess.Popen(["ip", "netns", "exec", self.ns[node], "tcpdump", "-i", ifn, "-Q", "out", "-U", "-n", "-s", "0",
                                  "-Z", "root", "-w", f, "tcp port 179"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.caps.append((f"{node}:{ifn}>{peer}", f, p))
        time.sleep(1.5)
        routers = [n for n in spec["nodes"] if n.get("bgp")]
        for n in routers: self.frr[n["name"]] = self.write_conf(n)
        for n in routers:
            d = self.frr[n["name"]]; c = self.conf_dir(n["name"])
            self.procs.append(subprocess.Popen(["ip", "netns", "exec", self.ns[n["name"]], f"{FRR}/zebra", "-f", f"{c}/zebra.conf", "-i", f"{d}/zebra.pid",
                                                "-z", f"{d}/zserv.api", "--vty_socket", d, "-P", "0"],
                                               stdout=open(f"{self.tmp}/zebra-{n['name']}.log", "w"), stderr=subprocess.STDOUT))
        time.sleep(2)
        for n in routers:
            d = self.frr[n["name"]]
            self.procs.append(subprocess.Popen(["ip", "netns", "exec", self.ns[n["name"]], f"{FRR}/bgpd", "-i", f"{d}/bgpd.pid",
                                                "-z", f"{d}/zserv.api", "--vty_socket", d, "-P", "0"],
                                               stdout=open(f"{self.tmp}/bgpd-{n['name']}.log", "w"), stderr=subprocess.STDOUT))
        time.sleep(1)
        self.t0 = time.time()
        for n in routers:   # load the config through vtysh, in spec order (the engine's routers start 0.1 s apart in the same order)
            d = self.frr[n["name"]]; c = self.conf_dir(n["name"])
            r = subprocess.run(["ip", "netns", "exec", self.ns[n["name"]], "vtysh", "--vty_socket", d, "-f", f"{c}/bgpd.conf"], capture_output=True, text=True)
            if r.returncode: raise RuntimeError(f"vtysh -f failed on {n['name']}: {r.stdout[-800:]}{r.stderr[-800:]}")
        self.t0 = time.time()

    def conf_dir(self, name): return f"{self.tmp}/frr-{name}"

    def write_conf(self, n):
        """Config files go in a temp dir; every runtime path goes in a per-router dir under /run/frr (see validate/ospf). Returns the latter."""
        d = self.conf_dir(n["name"]); os.makedirs(d)
        b = n["bgp"]; t = b.get("timers") or {}
        conf = [f"hostname {n['name']}", "!"]
        lp = any(x.get("localPref") is not None for x in b["neighbors"])
        conf += ["router bgp %d" % b["asn"]]
        if b.get("routerId"): conf += [f" bgp router-id {b['routerId']}"]
        conf += [" no bgp ebgp-requires-policy", " no bgp network import-check"] if False else [" no bgp ebgp-requires-policy"]
        if t.get("keepalive") or t.get("hold"):
            hold = t.get("hold", 180); conf += [f" timers bgp {t.get('keepalive', hold // 3)} {hold}"]
        for x in b["neighbors"]:
            ip = x["ip"]; nt = {**t, **(x.get("timers") or {})}
            conf += [f" neighbor {ip} remote-as {x['remoteAs']}"]
            if nt.get("keepalive") or nt.get("hold"):
                hold = nt.get("hold", 180); conf += [f" neighbor {ip} timers {nt.get('keepalive', hold // 3)} {hold}"]
            conf += [f" neighbor {ip} timers connect {nt.get('connect', 120)}"]
        conf += [" !", " address-family ipv4 unicast"]
        conf += [f"  network {x}" for x in b.get("networks", [])]
        for x in b["neighbors"]:
            if x.get("nextHopSelf"): conf += [f"  neighbor {x['ip']} next-hop-self"]
            if x.get("localPref") is not None: conf += [f"  neighbor {x['ip']} route-map LP{x['localPref']} in"]
        conf += [" exit-address-family", "!"]
        for v in sorted({x["localPref"] for x in b["neighbors"] if x.get("localPref") is not None}):
            conf += [f"route-map LP{v} permit 10", f" set local-preference {v}", "!"]
        Path(f"{d}/bgpd.conf").write_text("\n".join(conf) + "\n")
        Path(f"{d}/zebra.conf").write_text(f"hostname {n['name']}\n")
        shutil.chown(d, "frr", "frr")
        for f in os.listdir(d): shutil.chown(f"{d}/{f}", "frr", "frr"); os.chmod(f"{d}/{f}", 0o666)
        os.chmod(d, 0o777)
        os.makedirs("/run/frr", exist_ok=True); shutil.chown("/run/frr", "frr", "frr"); os.chmod("/run/frr", 0o775)
        rd = f"/run/frr/opr-{os.path.basename(self.tmp)}-{n['name']}"; os.makedirs(rd, exist_ok=True)
        shutil.chown(rd, "frr", "frr"); os.chmod(rd, 0o775)
        return rd

    def vty(self, name, cmd):
        r = subprocess.run(["ip", "netns", "exec", self.ns[name], "vtysh", "--vty_socket", self.frr[name], "-c", cmd], capture_output=True, text=True)
        if r.returncode:
            logs = "".join(f"\n--- {f}\n" + Path(f"{self.tmp}/{f}").read_text()[-1500:] for f in sorted(os.listdir(self.tmp)) if f.endswith(".log"))
            raise RuntimeError(f"vtysh {cmd!r} failed ({r.returncode}) on {name}: {r.stderr[-1500:]}{r.stdout[-500:]}\n{logs}")
        return r.stdout

    def state(self, name):
        """What bgpd says, in the engine's terms."""
        raw = os.environ.get("BGP_RAW")   # a file to append the raw vtysh JSON to (for developing the parsers)
        nb = json.loads(self.vty(name, "show bgp neighbors json") or "{}")
        tb = json.loads(self.vty(name, "show bgp ipv4 unicast json") or "{}")
        if raw: print(f"=== {name} neighbors", json.dumps(nb, indent=1), f"=== {name} table", json.dumps(tb, indent=1), file=open(raw, "a"))
        return {"neighbors": parse_neighbors(nb), "routes": parse_table(tb), "fib": self.fib(name)}

    def fib(self, name):
        out = []
        for r in json.loads(l3.nsx(self.ns[name], "ip", "-j", "route", "show")):
            if r.get("protocol") not in ("bgp", "186"): continue
            via = r.get("nexthops") or [r]
            out.append({"network": r["dst"], "gw": via[0].get("gateway"), "iface": via[0].get("dev")})
        return sorted(out, key=lambda r: (ip2int(r["network"].split("/")[0]), r["network"]))

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


def parse_neighbors(js):
    out = []
    for ip, v in js.items():
        up = v.get("bgpState") == "Established"
        out.append({"ip": ip, "remoteAs": v.get("remoteAs"), "up": up, "routerId": v.get("remoteRouterId") if up else None})
    return sorted(out, key=lambda n: ip2int(n["ip"]))


def parse_table(js):
    out = []
    for prefix, paths in (js.get("routes") or {}).items():
        for p in paths:
            best = p.get("bestpath"); best = best.get("overall", False) if isinstance(best, dict) else bool(best)
            nh = (p.get("nexthops") or [{}])[0].get("ip", "0.0.0.0")
            path = p.get("path", ""); path = " ".join(str(x) for x in path) if isinstance(path, list) else str(path)
            out.append({"prefix": prefix, "from": p.get("peerId") or "local", "best": best, "valid": bool(p.get("valid", False)), "nextHop": nh,
                        "asPath": path, "origin": str(p.get("origin", "IGP")).lower().replace("incomplete", "incomplete"), "localPref": p.get("locPrf", 100)})
    return sorted(out, key=lambda r: (ip2int(r["prefix"].split("/")[0]), r["prefix"], r["from"]))


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
        if ip[9] != 6: continue
        tcp = ip[ihl:]; payload = tcp[(tcp[12] >> 4) * 4:]
        t = sec + frac * scale; src, dst = ip4(ip[12:16]), ip4(ip[16:20])
        while len(payload) >= 19 and payload[:16] == b"\xff" * 16:
            ln = struct.unpack("!H", payload[16:18])[0]
            if ln < 19 or ln > len(payload): break
            body, typ = payload[19:ln], MSG.get(payload[18], payload[18])
            pk = {"t": t, "src": src, "dst": dst, "type": typ}
            if typ == "open": pk.update({"as": struct.unpack("!H", body[1:3])[0], "hold": struct.unpack("!H", body[3:5])[0], "routerId": ip4(body[5:9])})
            if typ == "update": pk.update(parse_update(body))
            out.append(pk); payload = payload[ln:]
    return out


def prefixes(b):
    out = []
    while b:
        n = b[0]; k = (n + 7) // 8; out.append(ip4((b[1:1 + k] + b"\0" * 4)[:4]) + f"/{n}"); b = b[1 + k:]
    return out


def parse_update(b):
    wl = struct.unpack("!H", b[:2])[0]; wd = prefixes(b[2:2 + wl]); b = b[2 + wl:]
    al = struct.unpack("!H", b[:2])[0]; attrs, nlri = b[2:2 + al], prefixes(b[2 + al:])
    pk = {"withdrawn": sorted(wd), "nlri": sorted(nlri)}
    while attrs:
        fl, code = attrs[0], attrs[1]
        if fl & 0x10: ln = struct.unpack("!H", attrs[2:4])[0]; v = attrs[4:4 + ln]; attrs = attrs[4 + ln:]
        else: ln = attrs[2]; v = attrs[3:3 + ln]; attrs = attrs[3 + ln:]
        if code == 1: pk["origin"] = ORIGINS.get(v[0], v[0])
        elif code == 2:
            asp = []
            while v:
                cnt = v[0]; asp += [struct.unpack("!I", v[2 + 4 * i:6 + 4 * i])[0] for i in range(cnt)]; v = v[2 + 4 * cnt:]   # bgpd negotiates 4-byte AS numbers
            pk["asPath"] = " ".join(map(str, asp))
        elif code == 3: pk["nextHop"] = ip4(v)
    return pk


def kernel_run(name):
    spec = json.loads(netfile(name).read_text()); steps = json.loads((HERE / f"{name}.steps.json").read_text())
    k = BgpNet(spec); out = []; clock = 0.0
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
                out.append({"t": time.time() - k.t0, "snapshot": s["snapshot"], "routers": {n["name"]: k.state(n["name"]) for n in spec["nodes"] if n.get("bgp")}})
        packets = k.packets()
        if os.environ.get("BGP_RAW"): print(f"=== {name} packets", json.dumps([p for p in packets if p["type"] != "keepalive"]), file=open(os.environ["BGP_RAW"], "a"))
    finally:
        k.close()
    return {"steps": out, "packets": packets}


def inner():
    l3.sh("mount", "-t", "tmpfs", "none", "/run")
    print(json.dumps({name: kernel_run(name) for name in sys.argv[2:] or SPECS}))


def phases(run):
    """Per snapshot: (snapshot, packets since the previous snapshot, packets before it and at it)."""
    snaps = [s for s in run["steps"] if "snapshot" in s]
    out, prev, pk = [], 0, run["packets"]
    for s in snaps:
        n = s["packets"] if "packets" in s else sum(1 for p in pk if p["t"] <= s["t"])
        out.append((s, pk[prev:n], pk[:n])); prev = n
    return out


def told(pkts):
    """What every router has told every neighbor, as the neighbor sees it: per cable direction, prefix -> (AS path, next hop, origin) of the last announcement not withdrawn since."""
    t = {}
    for p in pkts:
        if p["type"] != "update": continue
        d = t.setdefault(p["cable"], {})
        for x in p["withdrawn"]: d.pop(x, None)
        for x in p["nlri"]: d[x] = [p.get("asPath"), p.get("nextHop"), p.get("origin")]
    return {c: v for c, v in sorted(t.items()) if v}


def opens(pkts):
    last = {}
    for p in pkts:
        if p["type"] == "open": last[p["cable"]] = [p["as"], p["hold"], p["routerId"]]
    return last


def kinds(win):
    t = {}
    for p in win:
        if p["type"] != "keepalive": t.setdefault(p["cable"], set()).add(p["type"])
    return {c: sorted(v) for c, v in sorted(t.items())}


def up_text(r): return ", ".join(f'{n["ip"]} {"Established" if n["up"] else "down"}' for n in r["neighbors"]) or "no neighbors"


def compare(name, eng, kr):
    rows, detail = [], {}
    # the engine and Linux must have run the same steps: zip() alone would hide a missing snapshot or ping
    for what, e, k in (("snapshots", [s for s in eng["steps"] if "snapshot" in s], [s for s in kr["steps"] if "snapshot" in s]),
                       ("pings", [s for s in eng["steps"] if "ping" in s], [s for s in kr["steps"] if "ping" in s])):
        if len(e) != len(k):
            rows.append((name, what, f"engine {len(e)}, Linux {len(k)}", "same number of steps", "✗")); detail[f"{name}: {what}"] = {"engine": len(e), "linux": len(k)}
    if detail: return rows, detail
    for (es, ewin, eupto), (ks, kwin, kupto) in zip(phases(eng), phases(kr)):
        checks = {}
        for part in ("neighbors", "routes", "fib"): checks[part] = all(es["routers"][r][part] == ks["routers"][r][part] for r in es["routers"])
        checks["announced to every neighbor"] = told(eupto) == told(kupto)
        checks["OPEN on every cable"] = opens(eupto) == opens(kupto)
        checks["message types on every cable"] = kinds(ewin) == kinds(kwin)
        ok = all(checks.values())
        rows.append((name, es["snapshot"], "; ".join(f"{r}: {up_text(v)}" for r, v in es["routers"].items()),
                     ", ".join(f'{c} {"✓" if v else "✗"}' for c, v in checks.items()), "✓" if ok else "✗"))
        if not ok:
            d = {}
            for part in ("neighbors", "routes", "fib"):
                if not checks[part]: d[part] = {r: {"engine": es["routers"][r][part], "linux": ks["routers"][r][part]} for r in es["routers"] if es["routers"][r][part] != ks["routers"][r][part]}
            if not checks["announced to every neighbor"]:
                et, kt = told(eupto), told(kupto)
                d["announced"] = {c: {"engine": et.get(c), "linux": kt.get(c)} for c in sorted(set(et) | set(kt)) if et.get(c) != kt.get(c)}
            if not checks["OPEN on every cable"]:
                eo, ko = opens(eupto), opens(kupto)
                d["open"] = {c: {"engine": eo.get(c), "linux": ko.get(c)} for c in sorted(set(eo) | set(ko)) if eo.get(c) != ko.get(c)}
            if not checks["message types on every cable"]:
                et, kt = kinds(ewin), kinds(kwin)
                trace = lambda win, c: [[round(p["t"] - win[0]["t"], 1), p["type"], p.get("nlri"), p.get("withdrawn")] for p in win if p["cable"] == c and p["type"] != "keepalive"][:10]
                d["message types"] = {c: {"engine": et.get(c), "linux": kt.get(c), "engine trace": trace(ewin, c), "linux trace": trace(kwin, c)} for c in sorted(set(et) | set(kt)) if et.get(c) != kt.get(c)}
            detail[f'{name}: {es["snapshot"]}'] = d
    for ep_, kp_ in zip([s for s in eng["steps"] if "ping" in s], [s for s in kr["steps"] if "ping" in s]):
        e, k = l3.comparable(ep_["result"]), l3.comparable(kp_["result"]); ok = e == k
        what = f'ping {ep_["ping"][0]} → {ep_["ping"][1]} at {ep_["t"]:.0f} s'
        rows.append((name, what, ("ok" if e.get("ok") else e.get("error", "?")) + (f' from {e["from"]}' if e.get("from") else ""), "result", "✓" if ok else "✗"))
        if not ok: detail[f"{name}: {what}"] = {"engine": e, "linux": k}
    return rows, detail


def main():
    need = ["unshare", "ip", "tcpdump", "vtysh", f"{FRR}/bgpd", f"{FRR}/zebra"]
    if os.geteuid() != 0 or not all(shutil.which(x) or os.path.exists(x) for x in need):
        msg = "Needs root, unshare, iproute2, tcpdump and FRRouting (zebra, bgpd, vtysh)."
        if os.environ.get("GITHUB_ACTIONS"): print(msg + " Missing on the runner: failing.", file=sys.stderr); return 1
        print(msg + " Skipping."); return 0
    names = sys.argv[1:] or SPECS
    kern = json.loads(subprocess.run(["unshare", "-n", "-m", sys.executable, __file__, "--inner", *names], check=True,
                                     capture_output=True, text=True, timeout=1800).stdout)
    rows, detail = [], {}
    for name in names:
        eng = json.loads(l3.sh("node", str(ROOT / "engine" / "tools" / "run_bgp.mjs"), str(netfile(name)), str(HERE / f"{name}.steps.json")))
        nrows, ndetail = compare(name, eng, kern[name])
        rows += nrows; detail.update(ndetail)
    md = ["| Network | Snapshot | Engine sessions (same in bgpd?) | Checks | Match |", "|---|---|---|---|---|"]
    md += [f"| {a} | {b} | {c} | {d} | {e} |" for a, b, c, d, e in rows]
    (HERE / "results.md").write_text("\n".join(md) + "\n")
    (HERE / "mismatches.json").write_text(json.dumps(detail, indent=1))
    print("\n".join(md))
    chunk, part = [], 0
    for row in md + [None]:
        if row is None or sum(len(x) + 1 for x in chunk) + len(row) > 3000:
            if chunk: part += 1; l3.gh_note("notice", f"BGP results {part}", "\n".join(chunk))
            chunk = []
        if row is not None: chunk.append(row)
    if detail: print(json.dumps(detail, indent=1)[:8000]); l3.gh_note("error", "BGP engine vs bgpd mismatch", json.dumps(detail))
    return 0 if not detail else 1


if __name__ == "__main__":
    if sys.argv[1:2] == ["--inner"]: inner()
    else:
        try: sys.exit(main())
        except (subprocess.CalledProcessError, RuntimeError) as e:
            l3.gh_note("error", "BGP validation crashed", f"{e}\nstdout: {(getattr(e, 'stdout', '') or '')[-3000:]}\nstderr: {(getattr(e, 'stderr', '') or '')[-6000:]}")
            print((getattr(e, 'stderr', '') or str(e))[-6000:], file=sys.stderr)
            raise
