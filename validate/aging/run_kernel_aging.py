#!/usr/bin/env python3
"""MAC address aging: the engine vs real Linux kernel bridges (`ageing_time`), frame for frame.

    sudo python3 validate/aging/run_kernel_aging.py        (inside a privileged Linux container on a Mac)

The network (aging.json) has two switches with different aging times. The same steps (aging.steps.json)
run on the engine and on kernel bridges in network namespaces: pings (flooding vs unicast shows in the
per-cable frame counts), real waits, and snapshots of every switch's learned MAC table. All of it must
match exactly. The waits are chosen away from an expiry instant, because the kernel removes expired
entries from a garbage-collection timer, not at the exact instant. The whole run stays under 5 s because
a Linux host re-probes an ARP entry 5 s after first using it (a unicast ARP pair the engine does not model), so the
harness pins delay_first_probe_time high on every interface, like the other pinned settings.
"""
import json, os, shutil, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "validate" / "l3")); sys.path.insert(0, str(ROOT / "validate" / "l2"))
from run_kernel_l3 import sh, nsx  # noqa: E402
import run_kernel_l3 as l3  # noqa: E402
from run_kernel_l2 import Net  # noqa: E402

CASES = [("aging", "aging.steps")]
ALIGN = None   # seconds after a wall-clock second at which the bridges start and every step runs (validate/tcn sets 0.5); see below
WATCH = [("SW1", "p3")]   # (set to [] by validators that do not need the sniffer)


def macs(k):
    """MAC -> "node:iface" for every interface of every node."""
    m = {}
    for n in k.spec["nodes"]:
        ns = k.ns[n["name"]]
        for l in json.loads(sh("ip", "-n", ns, "-j", "link", "show")):
            if l["ifname"] != "lo": m[l["address"]] = f'{n["name"]}:{l["ifname"]}'
    return m


def table(k, sw, owner, fresh=False):
    """Dynamic (learned) entries of a switch: {"vlan|node:iface": port}."""
    out = {}
    for e in json.loads(nsx(k.ns[sw], "bridge", "-j", "fdb", "show", "br", "br0") or "[]"):
        if e.get("state") in ("permanent", "static") or e["mac"] not in owner: continue   # local addresses and group addresses are not learned
        if fresh and (e.get("state") == "stale" or k.kind[owner[e["mac"]].split(":")[0]] == "switch"): continue   # see run_aging.mjs
        out[f'{e.get("vlan", 0)}|{owner[e["mac"]]}'] = e["ifname"]
    return out


def kernel(name, steps_name, here=HERE):
    spec = json.loads((here / f"{name}.json").read_text()); steps = json.loads((here / f"{steps_name}.json").read_text())
    Net.DEFER_UP = True
    if any(n.get("channels") for n in spec["nodes"]):   # LACP hashes on MAC addresses: give every kernel interface the engine's
        Net.MACS = json.loads(sh("node", str(ROOT / "engine/tools/run_aging.mjs"), "--macs", str(here / f"{name}.json")))
    k = Net(spec); out = []; sniffers = []
    try:
        owner = macs(k)
        for n in spec["nodes"]:
            for l in json.loads(sh("ip", "-n", k.ns[n["name"]], "-j", "link", "show")):
                if l["ifname"] != "lo": nsx(k.ns[n["name"]], "sh", "-c", f"echo 100000 > /proc/sys/net/ipv4/neigh/{l['ifname']}/delay_first_probe_time")
        time.sleep(1.0); cum = 0.0
        if ALIGN is not None:
            # The kernel arms the spanning-tree hold timer with round_jiffies(), which rounds to whole wall-clock seconds, so
            # a pending BPDU leaves on a second boundary. Start the bridges ALIGN seconds after one and keep every step on
            # the engine's schedule from there (engine/src/stp.js _holdTime models the same rounding with jiffyHolds = ALIGN).
            time.sleep(1 - time.time() % 1)
            t_base = int(time.time()) + ALIGN
            time.sleep(max(t_base - time.time(), 0))
        for n in spec["nodes"]:   # the bridges' clocks (spanning tree, MAC collector) start now, as the engine's start at step 0
            if n["kind"] == "switch":
                sh("ip", "-n", k.ns[n["name"]], "link", "set", "br0", "up")
                for cn in (n.get("channels") or {}): sh("ip", "-n", k.ns[n["name"]], "link", "set", cn, "up")   # the bond's 802.3ad clock starts here, as the engine's does at step 0
        for sw, port in WATCH:   # diagnostic only: what the kernel really sent on these cables (shown if a step mismatches)
            f = f"/tmp/aging-{sw}-{port}.txt"; open(f, "w").close()
            sniffers.append(subprocess.Popen(["ip", "netns", "exec", k.ns[sw], sys.executable, str(HERE / "sniff.py"), port, f]))
        cables = {}   # "node:if>peer:if" -> file of the kinds of frames that interface sent (cable.py), for "bpdus" steps and "frames": "data"
        if any("bpdus" in s or s.get("frames") == "data" for s in steps):
            for (node, ifn), peer in k.ifmap.items():
                f = f"/tmp/cable-{node}-{ifn}.txt"; open(f, "w").close(); cables[f"{node}:{ifn}>{peer}"] = f
                sniffers.append(subprocess.Popen(["ip", "netns", "exec", k.ns[node], sys.executable, str(HERE / "cable.py"), ifn, f]))
        marks = {"ping": {c: 0 for c in cables}, "bpdus": {c: 0 for c in cables}}
        def sent(): return {c: [l.split()[0] for l in open(f).read().splitlines()] for c, f in cables.items()}   # (cable.py also writes each frame's time, for reading the files by hand)
        def window(who):   # what was sent since this reader last looked (pings and BPDU reports read independently)
            time.sleep(0.2); now = sent(); m = marks[who]; w = {c: now[c][m[c]:] for c in cables}; m.update({c: len(now[c]) for c in cables}); return w
        time.sleep(0.3)
        for s in steps:
            if ALIGN is not None: time.sleep(max(t_base + cum - time.time(), 0))   # not before the engine's time for this step
            if "wait" in s: cum += s["wait"]
            if s.get("flush"): k.flush()
            elif s.get("gcReset"):
                for n in spec["nodes"]:
                    if n["kind"] == "switch": sh("ip", "-n", k.ns[n["name"]], "link", "set", "br0", "type", "bridge", "ageing_time", str(int(n.get("agingTime", 300) * 100)))
            elif "wait" in s:
                if ALIGN is None: time.sleep(s["wait"])   # (aligned: the next step sleeps until its scheduled time)
            elif "ping" in s:
                if s.get("frames") == "data": window("ping")
                before = k.counters(); r = k.ping(*s["ping"]); cum += s.get("settle", 1); time.sleep(s.get("settle", 1) if ALIGN is None else max(t_base + cum - time.time(), 0)); after = k.counters()
                if s.get("frames") == "data": fr = {c: v.count("data") for c, v in window("ping").items() if v.count("data")}   # not counting spanning-tree frames
                else: fr = {x: after[x] - before.get(x, 0) for x in after if after[x] - before.get(x, 0)}
                out.append({"ping": s["ping"], "ok": bool(r.get("ok")), "wire": {f"{sw}:{p}": open(f"/tmp/aging-{sw}-{p}.txt").read().splitlines()[-40:] for sw, p in WATCH}, **({} if s.get("frames") is False else {"frames": fr})})
            elif s.get("bpdus") == "mark": window("bpdus")   # start a new window without reporting the one that ends (startup transients differ: the bridges come up a few ms apart)
            elif "bpdus" in s: out.append({"bpdus": True, "kinds": {c: sorted(set(v) - {"data"}) for c, v in window("bpdus").items() if set(v) - {"data"}}})
            elif "link" in s: k.link(s["link"]["end"], s["link"]["up"])   # {"end": "SW:port", "up": bool}, as the spec action `link`
            elif "tc" in s:
                b = {}
                for sw in s["tc"]:
                    p = lambda f: int(k.sysfs(k.ns[sw], "/sys/class/net/br0/bridge/" + f))
                    b[sw] = {"topologyChange": p("topology_change"), "topologyChangeDetected": p("topology_change_detected"), "agingTime": p("ageing_time") / 100}
                out.append({"tc": s["tc"], "bridges": b})
            elif "lacp" in s:   # each member's LACP state as the bonding driver reports it
                ch = {}
                for sw in s["lacp"]:
                    ch[sw] = {}
                    for cn, c in (k.node[sw].get("channels") or {}).items():
                        mem = {}
                        for p in c["ports"]:
                            d = json.loads(sh("ip", "-n", k.ns[sw], "-d", "-j", "link", "show", p))[0]["linkinfo"]["info_slave_data"]
                            up = d["mii_status"] == "UP"
                            mem[p] = {"up": up, "state": d["ad_actor_oper_port_state"] if up else None, "partnerState": d["ad_partner_oper_port_state"] if up else None}
                        ch[sw][cn] = mem
                out.append({"lacp": s["lacp"], "channels": ch})
            elif "table" in s: out.append({"table": s["table"], "tables": {sw: table(k, sw, owner, s.get("fresh", False)) for sw in s["table"]}})
    finally:
        for p in sniffers: p.kill()
        if os.environ.get("CABLE_DEBUG"):   # keep the per-cable timelines next to the steps, to read by hand
            for c, f in cables.items(): shutil.copy(f, here / f"timeline-{c.replace(':', '_').replace('>', '-')}.txt")
        k.close()
    return out


def inner(here=HERE, cases=CASES):
    sh("mount", "-t", "tmpfs", "none", "/run")
    print(json.dumps({n: kernel(n, st, here) for n, st in cases}))


def main(here=HERE, cases=CASES, script=__file__):
    if os.geteuid() != 0 or not shutil.which("unshare") or not shutil.which("ip") or not shutil.which("bridge"):
        print("Needs root, `unshare`, iproute2 (ip, bridge). Skipping."); return 0
    proc = subprocess.run(["unshare", "-n", "-m", sys.executable, script, "--inner"], capture_output=True, text=True, timeout=900)
    if proc.returncode:
        print("kernel side failed:\n" + proc.stderr[-3000:]); l3.gh_note("error", "Aging kernel side failed", proc.stderr[-6000:]); return 1
    kern = json.loads(proc.stdout)
    md = ["| Network | Step | Result | Match |", "|---|---|---|---|"]; ok_all = True; detail = {}
    for name, steps_name in cases:
        eng = json.loads(sh("node", str(ROOT / "engine/tools/run_aging.mjs"), str(here / f"{name}.json"), str(here / f"{steps_name}.json")))
        for i, (e, k) in enumerate(zip(eng, kern[name])):
            wire = k.pop("wire", None); ok = e == k; ok_all &= ok
            if "ping" in e:
                label = f'ping {e["ping"][0]} → {e["ping"][1]}'
                res = f'{"ok" if e["ok"] else "no reply"}' + (f' · {sum(e["frames"].values())} frames on {len(e["frames"])} cable directions' if "frames" in e else "")
            elif "bpdus" in e:
                label = "BPDU kinds per cable direction"; res = f'{len(e["kinds"])} cable directions with BPDUs'
            elif "lacp" in e:
                label = "LACP " + ", ".join(e["lacp"]); res = " · ".join(f'{sw}/{cn}: ' + ",".join(f'{p}={m["state"]}' for p, m in mem.items()) for sw, chs in e["channels"].items() for cn, mem in chs.items())
            elif "tc" in e:
                label = "topology change " + ", ".join(e["tc"]); res = " · ".join(f'{sw}: tc={b["topologyChange"]} aging={b["agingTime"]:g}s' for sw, b in e["bridges"].items())
            else:
                label = "MAC tables " + ", ".join(e["table"]); res = " · ".join(f'{sw}: {len(t)} entries' for sw, t in e["tables"].items())
            md.append(f'| {name} | {i + 1}. {label} | {res} | {"✓" if ok else "✗"} |')
            if not ok: detail[f"{name} step {i + 1}: {label}"] = {"engine": e, "kernel": k, "kernel_wire": wire}
        if len(eng) != len(kern[name]): ok_all = False; detail[f"{name}: step count"] = {"engine": len(eng), "kernel": len(kern[name])}
    (here / "results.md").write_text("\n".join(md) + "\n"); (here / "mismatches.json").write_text(json.dumps(detail, indent=1))
    print("\n".join(md))
    if detail: print(json.dumps(detail, indent=1)[:6000]); l3.gh_note("error", "Aging engine vs Linux mismatch", json.dumps(detail))
    return 0 if ok_all else 1


if __name__ == "__main__":
    if sys.argv[1:] == ["--inner"]: inner()
    else: sys.exit(main())
