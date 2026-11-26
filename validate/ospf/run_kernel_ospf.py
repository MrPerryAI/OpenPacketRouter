#!/usr/bin/env python3
"""OSPFv2: the engine vs FRRouting ospfd in Linux namespaces: neighbor states, DR/BDR, routing tables and packets.

    sudo python3 validate/ospf/run_kernel_ospf.py        # on a Mac: validate/docker/run.sh ospf

Builds each spec from network namespaces like validate/l3 (it reuses that harness). Every router with an `ospf`
key runs its own zebra + ospfd (FRRouting), configured from the spec: router ID, `network … area 0`, and per
interface the network type, cost, hello and dead interval and priority (the engine's defaults, written out, when the
spec says nothing). tcpdump records every OSPF packet sent out of every interface. The same steps (waits, cable
cuts, pings) run in the engine (engine/tools/run_ospf.mjs).

Compared at every snapshot, for every router:
  - the neighbors: router ID, address, interface, state and role (`Full/DR`, `2-Way/DROther`, `Full/-`);
  - the interfaces: state, DR and BDR address, cost, priority;
  - the routes ospfd put in the kernel: prefix, next hop, interface and metric (= the OSPF cost);
  - the link state database: which LSAs exist (type, ID, advertising router) and what the router and network LSAs say
    (links with type, ID, data and metric; attached routers), not sequence numbers, ages or checksums;
  - the last Hello from every router on every cable: source, destination, TTL, router ID, mask, intervals, options,
    priority, DR, BDR and neighbor list;
  - which packet types crossed every cable direction since the previous snapshot (Hello, Database Description, Link
    State Request/Update/Acknowledgment), and how many Hellos;
  - ping results at the steps that ask for one.
Not compared: exact times and the counts of every type but Hello (FRR delays acknowledgments and LSA origination
by timers that are only roughly the engine's); LSA sequence numbers, ages and checksums.
"""
import json, os, re, shutil, struct, subprocess, sys, tempfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "validate" / "l3"))
import run_kernel_l3 as l3  # noqa: E402

SPECS = ["ospf-p2p", "ospf-timers", "ospf-lan", "ospf-priority", "ospf-mixed", "ospf-areas", "ospf-redist"]
FRR = "/usr/lib/frr"
DEFAULTS = {"type": "broadcast", "priority": 1, "cost": 10, "hello": 10, "retransmit": 5}
PTYPES = {1: "hello", 2: "dd", 3: "lsr", 4: "lsu", 5: "ack"}


def netfile(name): return HERE / f"{name}.net"      # .net, not .json: see README (the CLI round-trip test reads every *.json spec)


class OspfNet(l3.KernelNet):
    def __init__(self, spec):
        super().__init__(spec)
        self.tmp = tempfile.mkdtemp(); os.chmod(self.tmp, 0o755); self.caps = []; self.frr = {}
        for (node, ifn), peer in sorted(self.ifmap.items()):
            f = f"{self.tmp}/{node}-{ifn}.pcap"
            p = subprocess.Popen(["ip", "netns", "exec", self.ns[node], "tcpdump", "-i", ifn, "-Q", "out", "-U", "-n", "-s", "0",
                                  "-Z", "root", "-w", f, "ip proto 89"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.caps.append((f"{node}:{ifn}>{peer}", f, p))
        time.sleep(1.5)
        routers = [n for n in spec["nodes"] if n.get("ospf")]
        for n in routers: self.frr[n["name"]] = self.write_conf(n)
        for n in routers:
            d = self.frr[n["name"]]; c = self.conf_dir(n["name"])
            self.procs.append(subprocess.Popen(["ip", "netns", "exec", self.ns[n["name"]], f"{FRR}/zebra", "-f", f"{c}/zebra.conf", "-i", f"{d}/zebra.pid",
                                                "-z", f"{d}/zserv.api", "--vty_socket", d, "-P", "0"],
                                               stdout=open(f"{self.tmp}/zebra-{n['name']}.log", "w"), stderr=subprocess.STDOUT))
        time.sleep(2)
        for n in routers:
            d = self.frr[n["name"]]
            self.procs.append(subprocess.Popen(["ip", "netns", "exec", self.ns[n["name"]], f"{FRR}/ospfd", "-i", f"{d}/ospfd.pid",
                                                "-z", f"{d}/zserv.api", "--vty_socket", d, "-P", "0"],
                                               stdout=open(f"{self.tmp}/ospfd-{n['name']}.log", "w"), stderr=subprocess.STDOUT))
        time.sleep(1)
        for n in routers:   # load the config through vtysh (ospfd has no -f in newer FRR)
            d = self.frr[n["name"]]; c = self.conf_dir(n["name"])
            r = subprocess.run(["ip", "netns", "exec", self.ns[n["name"]], "vtysh", "--vty_socket", d, "-f", f"{c}/ospfd.conf"], capture_output=True, text=True)
            if r.returncode: raise RuntimeError(f"vtysh -f failed on {n['name']}: {r.stdout[-800:]}{r.stderr[-800:]}")
        self.t0 = time.time()

    def conf_dir(self, name): return f"{self.tmp}/frr-{name}"

    def write_conf(self, n):
        """Config files go in a temp dir; every runtime path (pid files, zserv.api, vty sockets) goes in a per-router dir
        under /run/frr, the only place a host AppArmor profile confining the FRR daemons lets them write. Returns the latter."""
        d = self.conf_dir(n["name"]); os.makedirs(d)
        if os.environ.get("OSPF_RENDER") == "cli":   # ospfd's config comes only from the device CLI: the model -> FRR rendering
            sf = f"{self.tmp}/spec.json"; Path(sf).write_text(json.dumps(self.spec))
            out = subprocess.run(["node", str(Path(__file__).resolve().parents[2] / "cli/bin/opr-cli.mjs"), sf, n["name"], "--render", "frr"], capture_output=True, text=True, check=True).stdout
            # addresses, routes and "end" belong to zebra/the namespace setup, not to ospfd's own config
            keep = [l for l in out.splitlines() if not l.strip().startswith(("ip address", "ip route", "end", "shutdown")) and l.strip()]
            Path(f"{d}/ospfd.conf").write_text("\n".join(keep) + "\n")
            Path(f"{d}/zebra.conf").write_text(f"hostname {n['name']}\n")
            return self._finish_conf(n, d)
        o = n["ospf"]; ifc = o.get("interfaces") or {}
        conf = [f"hostname {n['name']}"]
        for ifn in n["ifaces"]:
            c = {**DEFAULTS, **ifc.get(ifn, {})}
            hello = c["hello"]; dead = c.get("dead", hello * 4)
            conf += [f"interface {ifn}", f" ip ospf network {'point-to-point' if c['type'] == 'point-to-point' else 'broadcast'}",
                     f" ip ospf cost {c['cost']}", f" ip ospf hello-interval {hello}", f" ip ospf dead-interval {dead}",
                     f" ip ospf priority {c['priority']}", f" ip ospf retransmit-interval {c['retransmit']}", "!"]
        conf += ["router ospf"]
        if o.get("routerId"): conf += [f" ospf router-id {o['routerId']}"]
        for r in o.get("redistribute", []):   # routes added with `ip route` are "kernel" routes to zebra, which is what the engine calls static
            conf += [f" redistribute {'kernel' if r['source'] == 'static' else r['source']} metric {r.get('metric', 20)} metric-type {r.get('metricType', 2)}"]
        conf += [f" passive-interface {x}" for x in o.get("passive", [])]
        for x in o["networks"]:
            area = "0.0.0.0"
            if isinstance(x, dict): area = area_id(x.get("area", 0)); x = x["network"]
            if "/" not in x: x = str(__import__("ipaddress").ip_interface(n["ifaces"][x]).network)
            conf += [f" network {x} area {area}"]
        conf += ["!"]
        Path(f"{d}/ospfd.conf").write_text("\n".join(conf) + "\n")
        Path(f"{d}/zebra.conf").write_text(f"hostname {n['name']}\n")
        return self._finish_conf(n, d)

    def _finish_conf(self, n, d):
        shutil.chown(d, "frr", "frr")   # the daemons run as their usual user "frr"
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
            raise RuntimeError(f"vtysh {cmd!r} failed ({r.returncode}) on {name}: {r.stderr[-1500:]}{r.stdout[-500:]}\n{subprocess.run(['ps', 'aux'], capture_output=True, text=True).stdout[-1500:]}{logs}")
        return r.stdout

    def state(self, name):
        """What ospfd says, in the engine's terms."""
        raw = os.environ.get("OSPF_RAW")   # a file to append the raw vtysh JSON to (for developing the parsers)
        nb = json.loads(self.vty(name, "show ip ospf neighbor json") or "{}")
        ifs = json.loads(self.vty(name, "show ip ospf interface json") or "{}")
        db = {k: json.loads(self.vty(name, f"show ip ospf database {k} json") or "{}") for k in ("router", "network", "summary", "asbr-summary", "external")}
        if raw: print(f"=== {name} neighbor", json.dumps(nb, indent=1), f"=== {name} interface", json.dumps(ifs, indent=1), f"=== {name} database", json.dumps(db, indent=1), file=open(raw, "a"))
        dbg = {"kernel": [f'{r.get("dst")} via {r.get("gateway")} dev {r.get("dev")} proto {r.get("protocol")}' for r in json.loads(l3.nsx(self.ns[name], "ip", "-j", "route", "show"))],
               "zebra": {pfx: [f'{r.get("protocol")}{" selected" if r.get("selected") else ""} {[(n.get("ip"), n.get("interfaceName"), "active" if n.get("active") else "inactive") for n in r.get("nexthops", [])]}' for r in rs]
                         for pfx, rs in json.loads(self.vty(name, "show ip route json") or "{}").items()}}   # not compared: what zebra and the kernel hold, for reading a mismatch
        return {"neighbors": parse_neighbors(nb), "interfaces": parse_interfaces(ifs), "routes": self.routes(name), "database": parse_database(db), "debug": dbg}

    def routes(self, name):
        """The routes ospfd got into the kernel (`ip route`: next hops) with their OSPF cost (zebra's table: the kernel metric is not the cost)."""
        z = json.loads(self.vty(name, "show ip route ospf json") or "{}")
        if os.environ.get("OSPF_RAW"): print(f"=== {name} zebra", json.dumps(z, indent=1), file=open(os.environ["OSPF_RAW"], "a"))
        cost = {pfx: min(r["metric"] for r in rs if r.get("protocol") == "ospf") for pfx, rs in z.items() if any(r.get("protocol") == "ospf" for r in rs)}
        out = []
        for r in json.loads(l3.nsx(self.ns[name], "ip", "-j", "route", "show")):
            if r.get("protocol") not in ("ospf", "188"): continue
            via = r.get("nexthops") or [r]
            out.append({"network": r["dst"], "cost": cost.get(r["dst"]), "via": sorted([{"gw": v.get("gateway"), "iface": v.get("dev")} for v in via], key=lambda v: (v["gw"] or "", v["iface"]))})
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


def area_id(a):
    """An area as dotted decimal: 1 -> 0.0.0.1 (the spec takes either)."""
    if isinstance(a, int) or str(a).isdigit(): a = int(a); return ".".join(str((a >> k) & 255) for k in (24, 16, 8, 0))
    return str(a)


def ip2int(s): return struct.unpack("!I", bytes(int(x) for x in s.split(".")))[0]
def ip4(b): return ".".join(str(x) for x in b)


LINK_TYPES = {"another Router (point-to-point)": "p2p", "Stub Network": "stub", "a Transit Network": "transit"}


def parse_neighbors(js):
    out = []
    for rid, lst in js.get("neighbors", js).items():
        for n in (lst if isinstance(lst, list) else [lst]):
            state, _, role = n["nbrState"].partition("/")
            out.append({"routerId": rid, "address": n["address"], "iface": n["ifaceName"].split(":")[0], "state": state, "role": role or "-"})
    return sorted(out, key=lambda n: (n["iface"], ip2int(n["routerId"])))


def parse_interfaces(js):
    out = []
    for name, i in js.get("interfaces", js).items():
        if not i.get("ospfEnabled") or not i.get("ifUp"): continue
        out.append({"iface": name, "state": i["state"], "type": "point-to-point" if i["networkType"] == "POINTOPOINT" else "broadcast",
                    "cost": i["cost"], "priority": i["priority"], "dr": i.get("drAddress", "0.0.0.0"), "bdr": i.get("bdrAddress", "0.0.0.0"), "passive": bool(i.get("timerPassiveIface"))})
    return sorted(out, key=lambda i: i["iface"])


def parse_database(js):
    """[{type, area, id, adv, links | maskLen, attached | maskLen, metric}] like the engine's database(): routers by ID, networks by DR address, summaries by prefix."""
    out = []
    for area, lsas in (js["router"].get("routerLinkStates", {}).get("areas", {}) or {}).items():
        for l in lsas or []:
            links = []
            for k in sorted(l["routerLinks"], key=lambda k: int(k[4:])):
                x = l["routerLinks"][k]; t = LINK_TYPES[x["linkType"]]
                links.append({"type": t, "id": {"p2p": x.get("neighborRouterId"), "stub": x.get("networkAddress"), "transit": x.get("designatedRouterAddress")}[t],
                              "data": {"p2p": x.get("routerInterfaceAddress"), "stub": x.get("networkMask"), "transit": x.get("routerInterfaceAddress")}[t], "metric": x["tos0Metric"]})
            if l["lsaAge"] >= 3600: continue   # flushed (MaxAge), waiting for ospfd's 30 s sweep to drop it; the engine drops it at once
            out.append({"type": "router", "area": area, "id": l["linkStateId"], "adv": l["advertisingRouter"], "links": links})
    for area, lsas in (js["network"].get("networkLinkStates", {}).get("areas", {}) or {}).items():
        for l in lsas or []:
            if l["lsaAge"] >= 3600: continue
            out.append({"type": "network", "area": area, "id": l["linkStateId"], "adv": l["advertisingRouter"], "maskLen": ml(l["networkMask"]), "attached": sorted(l["attchedRouters"], key=ip2int)})
    for area, lsas in (js["summary"].get("summaryLinkStates", {}).get("areas", {}) or {}).items():
        for l in lsas or []:
            if l["lsaAge"] >= 3600: continue
            out.append({"type": "summary", "area": area, "id": l["linkStateId"], "adv": l["advertisingRouter"], "maskLen": ml(l["networkMask"]), "metric": l.get("metric", l.get("tos0Metric"))})
    for area, lsas in (js["asbr-summary"].get("asbrSummaryLinkStates", {}).get("areas", {}) or {}).items():
        for l in lsas or []:
            if l["lsaAge"] >= 3600: continue
            out.append({"type": "asbr-summary", "area": area, "id": l["linkStateId"], "adv": l["advertisingRouter"], "maskLen": ml(l["networkMask"]), "metric": l.get("metric", l.get("tos0Metric"))})
    ext = js["external"].get("asExternalLinkStates", [])
    for l in (ext.get("lsas", []) if isinstance(ext, dict) else ext):
        if l["lsaAge"] >= 3600: continue
        mt = str(l.get("metricType", "")); et = 1 if mt.startswith("E1") else 2
        out.append({"type": "external", "area": "-", "id": l["linkStateId"], "adv": l["advertisingRouter"], "maskLen": ml(l["networkMask"]), "metric": l.get("metric"), "eType": et, "fwd": l.get("forwardAddress", "0.0.0.0")})
    return sorted(out, key=db_key)


TYPE_ORDER = {"router": 0, "network": 1, "summary": 2, "asbr-summary": 3, "external": 4}
def db_key(l): return (ip2int(l["area"]) if "." in l["area"] else -1, TYPE_ORDER[l["type"]], ip2int(l["id"]), ip2int(l["adv"]))
def ml(v): return v if isinstance(v, int) else mask_len(v)
def mask_len(m): return sum(bin(int(o)).count("1") for o in m.split("."))


def engine_database(db):
    out = []
    for l in db:
        e = {"type": l["type"], "area": l["area"], "id": l["id"], "adv": l["adv"]}
        if l["type"] == "router": e["links"] = l["links"]
        elif l["type"] == "network": e.update(maskLen=mask_len(l["mask"]), attached=sorted(l["attached"], key=ip2int))
        elif l["type"] == "external": e.update(area="-", maskLen=mask_len(l["mask"]), metric=l["metric"], eType=l["eType"], fwd=l["fwd"])
        else: e.update(maskLen=mask_len(l["mask"]), metric=l["metric"])
        out.append(e)
    return sorted(out, key=db_key)


def canon_router(r, kernel):
    """The comparable form of one router's state: sorted lists, links as sets, no sequence numbers."""
    db = r["database"] if kernel else engine_database(r["database"])
    for l in db:
        if "links" in l: l["links"] = sorted(l["links"], key=lambda x: (x["type"], ip2int(x["id"]), x["data"], x["metric"]))
    return {"neighbors": r["neighbors"], "interfaces": [{k: i[k] for k in ("iface", "state", "type", "cost", "priority", "dr", "bdr", "passive")} for i in r["interfaces"]],
            "routes": [{"network": x["network"], "cost": x["cost"], "via": x["via"]} for x in r["routes"]], "database": db}


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
        if ip[9] != 89: continue
        o = ip[ihl:]; typ = PTYPES.get(o[1], o[1])
        pk = {"t": sec + frac * scale, "src": ip4(ip[12:16]), "dst": ip4(ip[16:20]), "ttl": ip[8], "type": typ, "routerId": ip4(o[4:8])}
        if typ == "hello":
            b = o[24:]
            pk.update({"mask": ip4(b[0:4]), "helloInterval": struct.unpack("!H", b[4:6])[0], "options": b[6], "priority": b[7],
                       "deadInterval": struct.unpack("!I", b[8:12])[0], "dr": ip4(b[12:16]), "bdr": ip4(b[16:20]),
                       "neighbors": sorted(ip4(b[k:k + 4]) for k in range(20, len(b) - 3, 4))})
        if typ in ("lsu", "ack", "dd"):   # LSA headers (for debugging a mismatch; only `type` is compared)
            b = o[24:]; hs = []
            if typ == "lsu": cnt = struct.unpack("!I", b[:4])[0]; b = b[4:]
            if typ == "dd": b = b[8:]
            while len(b) >= 20 and (typ != "lsu" or len(hs) < cnt):
                ln = struct.unpack("!H", b[18:20])[0] if typ == "lsu" else 20
                hs.append(f"{b[3]}:{ip4(b[4:8])}/{ip4(b[8:12])}#{struct.unpack('!I', b[12:16])[0] & 0xff:x}"); b = b[ln:]
            pk["lsas"] = hs
        out.append(pk)
    return out


def kernel_run(name):
    spec = json.loads(netfile(name).read_text()); steps = json.loads((HERE / f"{name}.steps.json").read_text())
    k = OspfNet(spec); out = []; clock = 0.0
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
                out.append({"t": time.time() - k.t0, "snapshot": s["snapshot"], "routers": {n["name"]: k.state(n["name"]) for n in spec["nodes"] if n.get("ospf")}})
        packets = k.packets()
        if os.environ.get("OSPF_RAW"): print(f"=== {name} packets", json.dumps([p for p in packets if p["type"] != "hello"]), file=open(os.environ["OSPF_RAW"], "a"))
    finally:
        k.close()
    return {"steps": out, "packets": packets}


def inner():
    l3.sh("mount", "-t", "tmpfs", "none", "/run")
    print(json.dumps({name: kernel_run(name) for name in sys.argv[2:] or SPECS}))


HELLO_KEYS = ("src", "dst", "ttl", "routerId", "mask", "helloInterval", "deadInterval", "options", "priority", "dr", "bdr", "neighbors")


def phases(run, steps_spec):
    """Per snapshot: (snapshot, packets since the previous snapshot, packets before it and at it)."""
    snaps = [s for s in run["steps"] if "snapshot" in s]
    out, prev, pk = [], 0, run["packets"]
    for s in snaps:
        n = s["packets"] if "packets" in s else sum(1 for p in pk if p["t"] <= s["t"])
        out.append((s, pk[prev:n], pk[:n])); prev = n
    return out


def last_hellos(pkts):
    last = {}
    for p in pkts:
        if p["type"] == "hello": last[f'{p["cable"]} from {p["src"]}'] = {k: p[k] for k in HELLO_KEYS}
    return last


def kinds(win, switches=()):
    """Which packet types other than Hello crossed every cable direction (when a Hello went out depends on when a ping or a
    cable cut happened, and the last Hello on every cable is compared separately), and how many Hellos.
    One exception: a Link State Request on a switched LAN is recorded for the switch, not for its cables. A router that
    rejoins a LAN is adjacent to several routers at once and asks only for the LSAs it is still missing when each one's
    Database Description arrives; which neighbor's LSUs arrive first is a race in real time (ospfd skips a request
    the other neighbor's updates already answered, and which one it skips changes between runs; measured under CPU load
    with three containers at once: ospf-lan 6 of 9 runs, ospf-mixed 2 of 12, ospf-priority too), so "an LS Request
    crossed this switch" is deterministic but "to this router" is not."""
    t, hello = {}, {}
    for p in win:
        if p["type"] == "lsr":
            sw = next((n for n in switches if f"{n}:" in p["cable"]), None)
            if sw: t.setdefault(f"{sw}:*", set()).add("lsr"); continue
        if p["type"] != "hello": t.setdefault(p["cable"], set()).add(p["type"])
        if p["type"] == "hello": hello[p["cable"]] = hello.get(p["cable"], 0) + 1
    return {c: sorted(v) for c, v in t.items()}, hello


def nbr_text(r): return ", ".join(f'{n["iface"]}: {n["routerId"]} {n["state"]}/{n["role"]}' for n in r["neighbors"]) or "no neighbors"


def compare(name, eng, kr):
    """Engine run vs one ospfd run of the same network: (rows, detail); detail is empty when every row matches."""
    rows, detail = [], {}
    steps_spec = json.loads((HERE / f"{name}.steps.json").read_text())
    switches = [n["name"] for n in json.loads(netfile(name).read_text())["nodes"] if n.get("kind") == "switch"]
    wants = [s.get("lastHello", True) for s in steps_spec if "snapshot" in s]
    for (es, ewin, eupto), (ks, kwin, kupto), want in zip(phases(eng, steps_spec), phases(kr, steps_spec), wants):
        ec = {r: canon_router(v, False) for r, v in es["routers"].items()}; kc = {r: canon_router(v, True) for r, v in ks["routers"].items()}
        checks = {}
        for part in ("neighbors", "interfaces", "routes", "database"): checks[part] = all(ec[r][part] == kc[r][part] for r in ec)
        if want: checks["last hello on every cable"] = last_hellos(eupto) == last_hellos(kupto)
        et, eh = kinds(ewin, switches); kt, kh = kinds(kwin, switches)
        checks["packet types on every cable"] = et == kt
        ok = all(checks.values())
        rows.append((name, es["snapshot"], "; ".join(f"{r}: {nbr_text(v)}" for r, v in es["routers"].items()),
                     ", ".join(f'{c} {"✓" if v else "✗"}' for c, v in checks.items()) + f' · hellos {sum(eh.values())} (Linux {sum(kh.values())})', "✓" if ok else "✗"))
        if not ok:
            d = {}
            for part in ("neighbors", "interfaces", "routes", "database"):
                if checks[part]: continue
                if part == "database":   # only the LSAs that differ (the annotation GitHub keeps is short)
                    jd = lambda l: json.dumps(l, sort_keys=True)
                    d[part] = {r: {"engine only": sorted(set(map(jd, ec[r][part])) - set(map(jd, kc[r][part]))), "linux only": sorted(set(map(jd, kc[r][part])) - set(map(jd, ec[r][part])))} for r in ec if ec[r][part] != kc[r][part]}
                else: d[part] = {r: {"engine": ec[r][part], "linux": kc[r][part]} for r in ec if ec[r][part] != kc[r][part]}
            if not checks.get("last hello on every cable", True):
                el, kl = last_hellos(eupto), last_hellos(kupto)
                d["last hello"] = {c: {"engine": el.get(c), "linux": kl.get(c)} for c in sorted(set(el) | set(kl)) if el.get(c) != kl.get(c)}
            if not checks["packet types on every cable"]:
                d["packet types"] = {c: {"engine": et.get(c), "linux": kt.get(c)} for c in sorted(set(et) | set(kt)) if et.get(c) != kt.get(c)}
                trace = lambda win, c: [[round(p["t"] - win[0]["t"], 1), p.get("dst"), p["type"], p.get("lsas")] for p in win if p["cable"] == c and p["type"] != "hello"][:12]   # what crossed, for finding the cause
                for c in d["packet types"]: d["packet types"][c].update({"engine trace": trace(ewin, c), "linux trace": trace(kwin, c)})
                d["all cables (non-Hello, both sides)"] = {c: {"engine": trace(ewin, c), "linux": trace(kwin, c)} for c in sorted({p["cable"] for p in ewin + kwin}) if trace(ewin, c) or trace(kwin, c)}
            if not (checks["routes"] and checks["database"]): d["linux debug (zebra RIB and kernel routes)"] = {r: v.get("debug") for r, v in ks["routers"].items()}
            detail[f'{name}: {es["snapshot"]}'] = d
    for ep_, kp_ in zip([s for s in eng["steps"] if "ping" in s], [s for s in kr["steps"] if "ping" in s]):
        e, k = l3.comparable(ep_["result"]), l3.comparable(kp_["result"]); ok = e == k
        what = f'ping {ep_["ping"][0]} → {ep_["ping"][1]} at {ep_["t"]:.0f} s'
        rows.append((name, what, ("ok" if e.get("ok") else e.get("error", "?")) + (f' from {e["from"]}' if e.get("from") else ""), "result", "✓" if ok else "✗"))
        if not ok: detail[f"{name}: {what}"] = {"engine": e, "linux": k}
    return rows, detail


ATTEMPTS = 3


def only_p2p_acks(detail, switches):
    """True when the only differences are Acknowledgment packets on point-to-point cables. Whether ospfd sends a delayed
    ack, a direct ack after a retransmission, or none, depends on which of two copies of the same LSA (one direct, one
    flooded around a triangle) reaches the router first, a race in real time that the engine, following RFC 2328,
    cannot reproduce on every run (2 of 24 runs of ospf-p2p under CPU load). Anything else is never retried."""
    for d in detail.values():
        if set(d) - {"all cables (non-Hello, both sides)"} != {"packet types"}: return False
        for cable, v in d["packet types"].items():
            if any(f"{sw}:" in cable for sw in switches): return False
            if set(v["engine"] or []) ^ set(v["linux"] or []) != {"ack"}: return False
    return True


def main():
    need = ["unshare", "ip", "tcpdump", "vtysh", f"{FRR}/ospfd", f"{FRR}/zebra"]
    if os.geteuid() != 0 or not all(shutil.which(x) or os.path.exists(x) for x in need):
        msg = "Needs root, unshare, iproute2, tcpdump and FRRouting (zebra, ospfd, vtysh)."
        if os.environ.get("GITHUB_ACTIONS"): print(msg + " Missing on the runner: failing.", file=sys.stderr); return 1
        print(msg + " Skipping."); return 0
    names = sys.argv[1:] or SPECS
    kern = json.loads(subprocess.run(["unshare", "-n", "-m", sys.executable, __file__, "--inner", *names], check=True,
                                     capture_output=True, text=True, timeout=1800).stdout)
    rows, detail = [], {}
    for name in names:
        eng = json.loads(l3.sh("node", str(ROOT / "engine" / "tools" / "run_ospf.mjs"), str(netfile(name)), str(HERE / f"{name}.steps.json")))
        switches = [n["name"] for n in json.loads(netfile(name).read_text())["nodes"] if n.get("kind") == "switch"]
        kr = kern[name]
        for attempt in range(1, ATTEMPTS + 1):
            nrows, ndetail = compare(name, eng, kr)
            if not ndetail or attempt == ATTEMPTS or not only_p2p_acks(ndetail, switches): break
            print(f"{name}: only ack differences on point-to-point cables, running ospfd again (run {attempt + 1} of {ATTEMPTS})", file=sys.stderr)
            kr = json.loads(subprocess.run(["unshare", "-n", "-m", sys.executable, __file__, "--inner", name], check=True,
                                           capture_output=True, text=True, timeout=1800).stdout)[name]
        if attempt > 1: nrows = [r[:4] + (f"{r[4]} (matched on run {attempt} of {ATTEMPTS})" if not ndetail else f"{r[4]} (after {attempt} runs)",) for r in nrows]
        rows += nrows; detail.update(ndetail)
    md = ["| Network | Snapshot | Engine neighbors (same in ospfd?) | Checks | Match |", "|---|---|---|---|---|"]
    md += [f"| {a} | {b} | {c} | {d} | {e} |" for a, b, c, d, e in rows]
    (HERE / "results.md").write_text("\n".join(md) + "\n")
    (HERE / "mismatches.json").write_text(json.dumps(detail, indent=1))
    print("\n".join(md))
    chunk, part = [], 0   # the same table as annotations (the raw log can't be fetched): results.md is committed from a green run's
    for row in md + [None]:
        if row is None or sum(len(x) + 1 for x in chunk) + len(row) > 3000:
            if chunk: part += 1; l3.gh_note("notice", f"OSPF results {part}", "\n".join(chunk))
            chunk = []
        if row is not None: chunk.append(row)
    if detail: print(json.dumps(detail, indent=1)[:60000]); l3.gh_note("error", "OSPF engine vs ospfd mismatch", json.dumps(detail))
    return 0 if not detail else 1


if __name__ == "__main__":
    if sys.argv[1:2] == ["--inner"]: inner()
    else:
        try: sys.exit(main())
        except (subprocess.CalledProcessError, RuntimeError) as e:
            l3.gh_note("error", "OSPF validation crashed", f"{e}\nstdout: {(getattr(e, 'stdout', '') or '')[-3000:]}\nstderr: {(getattr(e, 'stderr', '') or '')[-6000:]}")
            print((getattr(e, 'stderr', '') or str(e))[-6000:], file=sys.stderr)
            raise
