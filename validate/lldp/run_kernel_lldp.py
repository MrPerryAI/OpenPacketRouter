#!/usr/bin/env python3
"""LLDP: the engine vs lldpd in Linux namespaces: neighbor tables, LLDPDU contents and LLDPDUs per cable.

Each node with an `lldp` key runs its own `lldpd` (one namespace per node, the cables are veth pairs, switches are
Linux bridges; `forwardLldp` sets the bridge's group_fwd_mask to 0x4000). lldpd is told the engine's choices:
host name, system description, TX interval and hold
multiplier; the chassis ID it picks itself, the MAC of the node's first (lowest-numbered) interface, which is the engine's choice too
(the specs list a node's interfaces in the order its cables are made). The same steps run in the engine (engine/tools/run_lldp.mjs). Compared:

  - at every snapshot, every node's neighbor table: interface, chassis ID, port ID, port description, system
    name, system description, enabled capabilities and TTL (MAC addresses are compared as "node:iface", since the
    engine's and the kernel's differ);
  - the LLDPDUs that crossed every cable direction between two snapshots: the set of distinct frames (TLV
    contents), and how many there were (within 1: lldpd's timers are real time, and its first frame after a change
    is not exactly the engine's 1 s);
  - destination MAC 01:80:c2:00:00:0e on every one.

Not compared: lldpd also sends a Management Address TLV and IEEE 802.3 / LLDP-MED organizationally specific TLVs; the
engine does not, so those TLVs are ignored on the Linux side.

Needs root, unshare, iproute2, tcpdump and lldpd; on a Mac run validate/docker/run.sh lldp.
"""
import json, os, re, shutil, struct, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "validate" / "l3"))
import run_kernel_l3 as l3  # noqa: E402

SPECS = ["lldp-direct", "lldp-switch"]
CAPS = {0x01: "other", 0x02: "repeater", 0x04: "bridge", 0x08: "wlan", 0x10: "router", 0x20: "phone", 0x40: "docsis", 0x80: "station"}
CAP_NAMES = {"Other": "other", "Repeater": "repeater", "Bridge": "bridge", "Wlan": "wlan", "Router": "router", "Phone": "phone", "Docsis": "docsis", "Station": "station"}


def netfile(name): return HERE / f"{name}.net"      # .net, not .json: the CLI round-trip test reads every *.json spec (see README)


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
        if len(frame) < 14 or frame[12:14] != b"\x88\xcc": continue
        tlvs, p = {}, 14
        while p + 2 <= len(frame):
            h = struct.unpack("!H", frame[p:p + 2])[0]; typ, ln = h >> 9, h & 0x1ff; v = frame[p + 2:p + 2 + ln]; p += 2 + ln
            if typ == 0: break
            if typ == 1: tlvs["chassisId"] = (v[0], mac_s(v[1:]) if v[0] == 4 else v[1:].decode(errors="replace"))
            elif typ == 2: tlvs["portId"] = (v[0], mac_s(v[1:]) if v[0] == 3 else v[1:].decode(errors="replace"))
            elif typ == 3: tlvs["ttl"] = struct.unpack("!H", v)[0]
            elif typ == 4: tlvs["portDescr"] = v.decode()
            elif typ == 5: tlvs["sysName"] = v.decode()
            elif typ == 6: tlvs["sysDescr"] = v.decode()
            elif typ == 7:
                en = struct.unpack("!HH", v[:4])[1]; tlvs["caps"] = [n for b, n in CAPS.items() if en & b]
        out.append({"t": sec + frac * scale, "dst": mac_s(frame[0:6]), "src": mac_s(frame[6:12]), "tlvs": tlvs})
    return out


class LldpNet(l3.KernelNet):
    def __init__(self, spec):
        super().__init__(spec)
        self.tmp = __import__("tempfile").mkdtemp(); os.chmod(self.tmp, 0o755); self.caps = []; self.macs = {}; self.talkers = [n for n in spec["nodes"] if n.get("lldp") is not None]
        for n in spec["nodes"]:
            if n["kind"] == "switch":
                if n.get("forwardLldp"): l3.sh("ip", "-n", self.ns[n["name"]], "link", "set", "br0", "type", "bridge", "group_fwd_mask", "0x4000")
                continue
            for l in json.loads(l3.sh("ip", "-n", self.ns[n["name"]], "-j", "link", "show")):
                if l["ifname"] != "lo": self.macs[l["address"]] = f'{n["name"]}:{l["ifname"]}'
        for n in self.talkers:
            for ifn in self.ifaces(n):
                f = f"{self.tmp}/{n['name']}-{ifn}.pcap"
                p = subprocess.Popen(["ip", "netns", "exec", self.ns[n["name"]], "tcpdump", "-i", ifn, "-Q", "out", "-U", "-n", "-s", "0", "-Z", "root", "-w", f, "ether proto 0x88cc"],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                self.caps.append((f"{n['name']}:{ifn}>{self.ifmap[(n['name'], ifn)]}", f, p))
        for n in spec["nodes"]:     # and what a forwarding switch sends out of its ports
            if n["kind"] != "switch": continue
            for ifn in self.ifaces(n):
                f = f"{self.tmp}/{n['name']}-{ifn}.pcap"
                p = subprocess.Popen(["ip", "netns", "exec", self.ns[n["name"]], "tcpdump", "-i", ifn, "-Q", "out", "-U", "-n", "-s", "0", "-Z", "root", "-w", f, "ether proto 0x88cc"],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                self.caps.append((f"{n['name']}:{ifn}>{self.ifmap[(n['name'], ifn)]}", f, p))
        time.sleep(1.5)
        for n in self.talkers:
            ns = self.ns[n["name"]]
            subprocess.run(["ip", "netns", "exec", ns, "lldpd", "-u", self.sock(n), "-I", ",".join(self.ifaces(n))], check=True)
        time.sleep(3)
        for n in self.talkers:
            ll = n["lldp"]
            for c in (["configure", "system", "hostname", n["name"]],
                      ["configure", "system", "description", ll.get("description", f"OpenPacketRouter {n['kind']}")],
                      ["configure", "lldp", "tx-hold", str(ll.get("holdMultiplier", 4))],
                      ["configure", "lldp", "tx-interval", str(ll.get("txInterval", 30))]):   # the last one sends a frame at once with all of them
                r = subprocess.run(["ip", "netns", "exec", ns_of(self, n), "lldpcli", "-u", self.sock(n), *c], capture_output=True, text=True)
                if r.returncode: raise RuntimeError(f"lldpcli {' '.join(c)} on {n['name']}: {r.stdout}{r.stderr}")
        self.t0 = time.time()      # lldpd sends a frame as the last setting is applied: its frames leave at about t0 + k × interval

    def ifaces(self, n): return [ifn for (node, ifn) in self.ifmap if node == n["name"]]
    def sock(self, n): return f"{self.tmp}/{n['name']}.sock"

    def neighbors(self, n):
        r = subprocess.run(["ip", "netns", "exec", self.ns[n["name"]], "lldpcli", "-u", self.sock(n), "-f", "json", "show", "neighbors"], capture_output=True, text=True)
        if r.returncode: raise RuntimeError(f"lldpcli show neighbors on {n['name']}: {r.stdout}{r.stderr}")
        ifs = (json.loads(r.stdout or "{}").get("lldp") or {}).get("interface") or {}
        if isinstance(ifs, list): ifs = {k: v for d in ifs for k, v in d.items()}
        out = []
        for ifn, e in ifs.items():
            (sysname, ch), = e["chassis"].items(); port = e["port"]
            caps = sorted(CAP_NAMES[c["type"]] for c in (ch.get("capability") or []) if c["enabled"])
            out.append({"iface": ifn, "chassisId": self.mac(ch["id"]), "portId": self.mac(port["id"]), "portDescr": port.get("descr"), "sysName": sysname,
                        "sysDescr": ch.get("descr"), "caps": caps, "ttl": int(port["ttl"])})
        return sorted(out, key=lambda x: x["iface"])

    def mac(self, i): return self.macs.get(i["value"], i["value"]) if i["type"] == "mac" else f'{i["type"]}:{i["value"]}'

    def link(self, ref, up):
        node, ifn = ref.split(":")
        l3.sh("ip", "-n", self.ns[node], "link", "set", ifn, "up" if up else "down")

    def packets(self):
        for _, _, p in self.caps: p.terminate()
        for _, _, p in self.caps: p.wait()
        out = []
        for cable, f, _ in self.caps: out += [{**pkt, "cable": cable, "t": pkt["t"] - self.t0} for pkt in read_pcap(f) if pkt["t"] >= self.t0]   # not the frames lldpd sent while being configured
        return sorted(out, key=lambda p: p["t"])

    def close(self):
        subprocess.run(["pkill", "lldpd"], check=False)
        for _, _, p in self.caps: p.kill()
        super().close()
        shutil.rmtree(self.tmp, ignore_errors=True)


def ns_of(k, n): return k.ns[n["name"]]


def kernel_run(name):
    spec = json.loads(netfile(name).read_text()); steps = json.loads((HERE / f"{name}.steps.json").read_text())
    k = LldpNet(spec); out = []; clock = 0.0
    try:
        for s in steps:
            if "wait" in s:
                clock += s["wait"]; time.sleep(max(0.0, k.t0 + clock - time.time()))
            elif "linkDown" in s: k.link(s["linkDown"], False)
            elif "linkUp" in s: k.link(s["linkUp"], True)
            elif "snapshot" in s:
                out.append({"t": time.time() - k.t0, "snapshot": s["snapshot"], "nodes": {n["name"]: k.neighbors(n) for n in k.talkers}})
        frames = k.packets(); macs = dict(k.macs)
        if os.environ.get("LLDP_RAW"): print(f"=== {name}", json.dumps([(round(f["t"], 2), f["cable"]) for f in frames]), file=open(os.environ["LLDP_RAW"], "a"))
        if os.environ.get("LLDP_RAW"): print(f"=== {name} steps", json.dumps([(round(x["t"], 2), x["snapshot"], {n: [y["sysName"] for y in v] for n, v in x["nodes"].items()}) for x in out]), file=open(os.environ["LLDP_RAW"], "a"))
    finally:
        k.close()
    return {"macs": macs, "steps": out, "frames": frames}


def inner():
    l3.sh("mount", "-t", "tmpfs", "none", "/run")
    print(json.dumps({name: kernel_run(name) for name in sys.argv[2:] or SPECS}))


def canon_frame(f, macs):
    t = dict(f["tlvs"]); sub = lambda m: macs.get(m, m)
    c = t.get("chassisId"); p = t.get("portId")
    t["chassisId"] = sub(c[1]) if isinstance(c, (list, tuple)) else sub(c)
    t["portId"] = sub(p[1]) if isinstance(p, (list, tuple)) else sub(p)
    return json.dumps({**t, "dst": f["dst"], "src": sub(f["src"])}, sort_keys=True)


def canon_nbrs(lst, macs):
    return [{**n, "chassisId": macs.get(n["chassisId"], n["chassisId"]), "portId": macs.get(n["portId"], n["portId"]), "caps": sorted(n["caps"])} for n in lst]


def phases(run):
    out, prev, fr = [], 0, run["frames"]
    for s in run["steps"]:
        n = s["frames"] if "frames" in s else sum(1 for p in fr if p["t"] <= s["t"])
        out.append((s, fr[prev:n])); prev = n
    return out


def per_cable(win, macs):
    d = {}
    for f in win: d.setdefault(f["cable"], []).append(canon_frame(f, macs))
    return d


def main():
    need = ["unshare", "ip", "tcpdump", "lldpd", "lldpcli"]
    if os.geteuid() != 0 or not all(shutil.which(x) for x in need):
        print("Needs root, unshare, iproute2, tcpdump and lldpd. Skipping."); return 0
    names = sys.argv[1:] or SPECS
    kern = json.loads(subprocess.run(["unshare", "-n", "-m", sys.executable, __file__, "--inner", *names], check=True,
                                     capture_output=True, text=True, timeout=1800).stdout)
    rows, detail = [], {}
    for name in names:
        eng = json.loads(l3.sh("node", str(ROOT / "engine" / "tools" / "run_lldp.mjs"), str(netfile(name)), str(HERE / f"{name}.steps.json")))
        kr = kern[name]
        for (es, ewin), (ks, kwin) in zip(phases(eng), phases(kr)):
            en = {n: canon_nbrs(v, eng["macs"]) for n, v in es["nodes"].items()}; kn = {n: canon_nbrs(v, kr["macs"]) for n, v in ks["nodes"].items()}
            ef, kf = per_cable(ewin, eng["macs"]), per_cable(kwin, kr["macs"])
            checks = {"neighbor tables": en == kn,
                      "LLDPDU contents": {c: sorted(set(v)) for c, v in ef.items()} == {c: sorted(set(v)) for c, v in kf.items()},
                      "LLDPDUs per cable (within 1)": all(abs(len(ef.get(c, [])) - len(kf.get(c, []))) <= 1 for c in set(ef) | set(kf))}
            ok = all(checks.values())
            table = "; ".join(f"{n}: " + (", ".join(f'{x["iface"]}={x["sysName"]}' for x in v) or "none") for n, v in en.items())
            rows.append((name, es["snapshot"], table, ", ".join(f'{c} {"✓" if v else "✗"}' for c, v in checks.items()) + f' · LLDPDUs {sum(len(v) for v in ef.values())} (Linux {sum(len(v) for v in kf.values())})', "✓" if ok else "✗"))
            if not ok:
                d = {}
                if not checks["neighbor tables"]: d["neighbor tables"] = {n: {"engine": en[n], "linux": kn.get(n)} for n in en if en[n] != kn.get(n)}
                if not checks["LLDPDU contents"]: d["LLDPDU contents"] = {c: {"engine": sorted(set(ef.get(c, []))), "linux": sorted(set(kf.get(c, [])))} for c in sorted(set(ef) | set(kf)) if sorted(set(ef.get(c, []))) != sorted(set(kf.get(c, [])))}
                if not checks["LLDPDUs per cable (within 1)"]: d["counts"] = {c: {"engine": len(ef.get(c, [])), "linux": len(kf.get(c, []))} for c in sorted(set(ef) | set(kf)) if abs(len(ef.get(c, [])) - len(kf.get(c, []))) > 1}
                detail[f'{name}: {es["snapshot"]}'] = d
    md = ["| Network | Snapshot | Engine neighbor tables (same in lldpd?) | Checks | Match |", "|---|---|---|---|---|"]
    md += [f"| {a} | {b} | {c} | {d} | {e} |" for a, b, c, d, e in rows]
    (HERE / "results.md").write_text("\n".join(md) + "\n")
    (HERE / "mismatches.json").write_text(json.dumps(detail, indent=1))
    print("\n".join(md))
    if detail: print(json.dumps(detail, indent=1)[:8000]); l3.gh_note("error", "LLDP engine vs lldpd mismatch", json.dumps(detail))
    return 0 if not detail else 1


if __name__ == "__main__":
    if sys.argv[1:2] == ["--inner"]: inner()
    else:
        try: sys.exit(main())
        except (subprocess.CalledProcessError, RuntimeError) as e:
            l3.gh_note("error", "LLDP validation crashed", f"{e}\nstdout: {(getattr(e, 'stdout', '') or '')[-3000:]}\nstderr: {(getattr(e, 'stderr', '') or '')[-6000:]}")
            print((getattr(e, 'stderr', '') or str(e))[-6000:], file=sys.stderr)
            raise
