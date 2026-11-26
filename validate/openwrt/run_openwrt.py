#!/usr/bin/env python3
"""The device CLI's OpenWrt rendering, applied by a real OpenWrt (its own `uci`) and read back.

    python3 validate/openwrt/run_openwrt.py        (needs docker; CI runs it on the runner)

For every device of every example lab that has addresses or static routes, this renders the UCI batch with

    node cli/bin/opr-cli.mjs SPEC DEVICE --render openwrt

feeds it to `uci batch` inside the official OpenWrt rootfs container (an empty /etc/config/network), then reads
the result back with `uci show network` and compares it with the spec: every interface address and mask, and
every static route (target, mask, gateway). This proves OpenWrt itself accepts what the CLI renders and stores
exactly the engine's configuration. It does not boot netifd (no kernel configuration is applied here).
"""
import glob, ipaddress, json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
IMAGE = os.environ.get("OPENWRT_IMAGE", "openwrt/rootfs:x86_64-23.05.5")

def sh(args, stdin=None):
    return subprocess.run(args, input=stdin, capture_output=True, text=True, cwd=ROOT)

def render(spec, dev):
    r = sh(["node", "cli/bin/opr-cli.mjs", spec, dev, "--render", "openwrt"])
    if r.returncode: sys.exit(f"render {spec} {dev}: {r.stderr}")
    return r.stdout

def apply(cmds):
    script = "mkdir -p /etc/config /var/lock; touch /etc/config/network; uci batch || exit 3; uci show network"
    r = sh(["docker", "run", "--rm", "-i", IMAGE, "sh", "-c", script], stdin=cmds)
    if r.returncode: return None, r.stderr or r.stdout
    return r.stdout, ""

def parse(show):
    secs = {}
    for line in show.splitlines():
        m = re.match(r"network\.([^.=]+)(?:\.(\w+))?=(.*)$", line)
        if not m: continue
        name, opt, val = m.groups()
        d = secs.setdefault(name, {})
        if opt: d[opt] = val.strip("'")
        else: d["_type"] = val.strip("'")
    return secs

def check(spec, node, secs):
    errs = []
    want_ifs = {n: ipaddress.ip_interface(c) for n, c in (node.get("ifaces") or {}).items() if isinstance(c, str)}
    got = {v.get("device"): v for v in secs.values() if v.get("_type") == "interface"}
    for name, ifc in want_ifs.items():
        g = got.get(name)
        if not g: errs.append(f"{name}: no interface section"); continue
        if g.get("ipaddr") != str(ifc.ip) or g.get("netmask") != str(ifc.netmask):
            errs.append(f"{name}: got {g.get('ipaddr')}/{g.get('netmask')}, want {ifc.ip}/{ifc.netmask}")
    routes = [(v.get("target"), v.get("netmask"), v.get("gateway")) for v in secs.values() if v.get("_type") == "route"]
    for prefix, nh in node.get("routes") or []:
        n = ipaddress.ip_network(prefix)
        if (str(n.network_address), str(n.netmask), nh) not in routes:
            errs.append(f"route {prefix} via {nh} missing (have {routes})")
    return errs

def main():
    bad = checked = 0
    for path in sorted(glob.glob(os.path.join(ROOT, "examples", "*", "spec.json"))):
        spec = os.path.relpath(path, ROOT)
        for node in json.load(open(path))["nodes"]:
            if not (node.get("ifaces") or node.get("routes")): continue
            if node["kind"] == "switch" and not any(isinstance(c, str) for c in (node.get("ifaces") or {}).values()) and not node.get("routes"): continue
            out, err = apply(render(spec, node["name"]))
            checked += 1
            if out is None: print(f"FAIL {spec} {node['name']}: uci refused: {err.strip()[:300]}"); bad += 1; continue
            errs = check(spec, node, parse(out))
            if errs: print(f"FAIL {spec} {node['name']}: " + "; ".join(errs)); bad += 1
            else: print(f"ok   {spec} {node['name']}")
    print(f"{checked} devices checked, {bad} failed")
    sys.exit(1 if bad or not checked else 0)

main()
