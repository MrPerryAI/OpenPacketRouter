#!/usr/bin/env python3
"""The device CLI's OpenWrt rendering, applied by a real OpenWrt (its own `uci`) and read back.

    python3 validate/openwrt/run_openwrt.py        (needs docker; CI runs it on the runner)

For every device of every example lab that has addresses or static routes, this renders the UCI batch with

    node cli/bin/opr-cli.mjs SPEC DEVICE --render openwrt

feeds it to `uci batch` inside the official OpenWrt rootfs container (an empty /etc/config/network), then reads
the result back with `uci show network` and compares it with the spec: every interface address and mask, and
every static route (target, mask, gateway), for IPv4 and IPv6 (ip6addr lists and route6 sections). This proves OpenWrt itself accepts what the CLI renders and stores
exactly the engine's configuration. It does not boot netifd (no kernel configuration is applied here).
"""
import glob, ipaddress, json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
IMAGE = os.environ.get("OPENWRT_IMAGE", "openwrt/rootfs:x86_64-23.05.5")

def note(level, title, text):
    """On GitHub Actions also an annotation (readable with `gh api .../annotations` when the raw log is not)."""
    if os.environ.get("GITHUB_ACTIONS"):
        esc = str(text)[:9000].replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
        print(f"::{level} title={title}::{esc}", flush=True)

def sh(args, stdin=None):
    return subprocess.run(args, input=stdin, capture_output=True, text=True, cwd=ROOT)

def render(spec, dev):
    r = sh(["node", "cli/bin/opr-cli.mjs", spec, dev, "--render", "openwrt"])
    if r.returncode: raise RuntimeError(f"render {spec} {dev}: {r.stderr.strip()[:300]}")
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
        if opt:
            vals = re.findall(r"'([^']*)'", val)
            d[opt] = val.strip("'") if len(vals) < 2 else vals      # a UCI list prints as 'a' 'b'
            if opt in ("ip6addr", "ports"): d[opt] = vals
        else: d["_type"] = val.strip("'")
    return secs

def pull():
    r = sh(["docker", "pull", IMAGE])
    if r.returncode:
        note("error", "OpenWrt image", f"docker pull {IMAGE} failed: {r.stderr.strip()[-600:]}")
        sys.exit(f"docker pull {IMAGE} failed: {r.stderr.strip()[-600:]}")

def check(spec, node, secs):
    errs = []
    errs = []
    got = {v.get("device"): v for v in secs.values() if v.get("_type") == "interface"}
    for name, c in (node.get("ifaces") or {}).items():
        if not isinstance(c, str): continue
        g = got.get(name)
        if c.strip().lower() == "dhcp":           # a DHCP client: OpenWrt must store proto=dhcp and no static address
            if not g: errs.append(f"{name}: no interface section")
            elif g.get("proto") != "dhcp" or "ipaddr" in g: errs.append(f"{name}: want proto dhcp, got {g.get('proto')} {g.get('ipaddr')}")
            continue
        try: ifc = ipaddress.ip_interface(c)
        except ValueError: errs.append(f"{name}: spec value {c!r} is neither CIDR nor dhcp"); continue
        if not g: errs.append(f"{name}: no interface section"); continue
        if g.get("ipaddr") != str(ifc.ip) or g.get("netmask") != str(ifc.netmask):
            errs.append(f"{name}: got {g.get('ipaddr')}/{g.get('netmask')}, want {ifc.ip}/{ifc.netmask}")
    for name, c in (node.get("ifaces6") or {}).items():
        ifc6 = ipaddress.ip_interface(c)
        g = got.get(name)
        if not g: errs.append(f"{name}: no interface section for {c}"); continue
        have = [ipaddress.ip_interface(x) for x in (g.get("ip6addr") or [])]
        if ifc6 not in have: errs.append(f"{name}: ip6addr want {c}, have {[str(x) for x in have]}")
    routes6 = [(str(ipaddress.ip_network(v.get("target"))), v.get("gateway")) for v in secs.values() if v.get("_type") == "route6"]
    wanted6 = [(str(ipaddress.ip_network(d)), nh) for d, nh in (node.get("routes6") or [])]
    if node.get("gw6"): wanted6.append(("::/0", node["gw6"]))
    for d, nh in wanted6:
        if (d, nh) not in routes6: errs.append(f"route6 {d} via {nh} missing (have {routes6})")
    if node.get("vlans"):
        want = set()
        for p, c in node["vlans"].items():
            if c.get("access") is not None: want.add((c["access"], p, "u*"))
            for v in (c.get("trunk") if isinstance(c.get("trunk"), list) else []):
                if v != c.get("native"): want.add((v, p, "t"))
            if c.get("native") is not None: want.add((c["native"], p, "u*"))
        have = set()
        for v in secs.values():
            if v.get("_type") == "bridge-vlan":
                for m in v.get("ports", []):
                    port, _, mode = m.partition(":"); have.add((int(v["vlan"]), port, mode))
        if want != have: errs.append(f"bridge-vlan: want {sorted(want)}, have {sorted(have)}")
    routes = [(v.get("target"), v.get("netmask"), v.get("gateway")) for v in secs.values() if v.get("_type") == "route"]
    wanted = list(node.get("routes") or [])
    if node.get("gw"): wanted.append(["0.0.0.0/0", node["gw"]])      # the default gateway is rendered as a 0.0.0.0/0 route
    for prefix, nh in wanted:
        n = ipaddress.ip_network(prefix)
        if (str(n.network_address), str(n.netmask), nh) not in routes:
            errs.append(f"route {prefix} via {nh} missing (have {routes})")
    return errs

def main():
    pull()
    bad = checked = 0
    rows = []
    for path in sorted(glob.glob(os.path.join(ROOT, "examples", "*", "spec.json"))) + [os.path.join(ROOT, "validate", "ipv6", "ipv6-lab.json")]:   # the lab specs, plus the IPv6 validator's own
        spec = os.path.relpath(path, ROOT)
        for node in json.load(open(path))["nodes"]:
            if not (node.get("ifaces") or node.get("routes") or node.get("gw") or node.get("ifaces6") or node.get("routes6") or node.get("gw6") or node.get("vlans")): continue
            if node["kind"] == "switch" and not any(isinstance(c, str) for c in (node.get("ifaces") or {}).values()) and not node.get("routes") and not node.get("vlans"): continue
            checked += 1
            try:
                out, err = apply(render(spec, node["name"]))
                errs = [f"uci refused: {err.strip()[:300]}"] if out is None else check(spec, node, parse(out))
            except Exception as e:       # one bad device is a FAIL with an annotation, not the end of the run
                errs = [f"{type(e).__name__}: {e}"]
            tag = f"{spec} {node['name']}"
            if errs:
                bad += 1; print(f"FAIL {tag}: " + "; ".join(errs)); rows.append(f"FAIL {tag}")
                note("error", f"OpenWrt {tag}", "; ".join(errs))
            else: print(f"ok   {tag}"); rows.append(f"ok   {tag}")
    summary = f"{checked} devices checked, {bad} failed"
    print(summary)
    print("not covered here: OSPF/RIP/RIPng (UCI has no routing-protocol sections; they go through the FRR backend), STP/LACP/port security, ACL/NAT/firewall, DHCP pools (not rendered for OpenWrt yet); netifd is not booted")
    note("notice", "OpenWrt results", summary + "\n" + "\n".join(rows))
    sys.exit(1 if bad or not checked else 0)

main()
