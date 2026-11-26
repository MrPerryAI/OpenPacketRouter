#!/usr/bin/env python3
"""DHCP snooping (server-message filtering): the engine vs Linux (nftables in the bridge family), frame for frame.

    sudo python3 validate/dhcp-snooping/run_kernel_snoop.py        (inside a privileged Linux container on a Mac)

Linux has no DHCP snooping feature, so the reference is the netfilter mechanism that does the one job the engine models:
on each untrusted port, a bridge-family prerouting rule drops DHCP server messages (UDP source port 67, destination
port 68) before the bridge sees them, with a counter per port:

    iifname "p3" ether type ip ip protocol udp udp sport 67 udp dport 68 counter name d_p3 drop

The DHCP servers are dnsmasq and the clients busybox udhcpc, exactly as in validate/dhcp. A rogue server on an untrusted
port answers every DISCOVER, and none of its offers may reach a client. Compared: every client's result, the frames on every
cable direction, and each port's drop count. Not modeled, and not validatable against Linux: the binding table, dynamic
ARP inspection and IP source guard.
"""
import json, os, shutil, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "validate" / "l3")); sys.path.insert(0, str(ROOT / "validate" / "dhcp"))
import run_kernel_l3 as l3  # noqa: E402
from run_kernel_dhcp import DhcpNet  # noqa: E402

NAME = "snoop"


def ports_of(spec, sw):
    return [e.split(":")[1] for l in spec["links"] for e in l[:2] if e.split(":")[0] == sw]


def ruleset(spec, sw, trusted):
    untrusted = [p for p in ports_of(spec, sw) if p not in trusted]
    out = ["table bridge snoop {"] + [f"  counter d_{p} {{ }}" for p in untrusted]
    out += ["  chain pre { type filter hook prerouting priority -300; policy accept;"]
    out += [f'    iifname "{p}" ether type ip ip protocol udp udp sport 67 udp dport 68 counter name "d_{p}" drop' for p in untrusted]
    return "\n".join(out + ["  }", "}"]) + "\n"


class SnoopNet(DhcpNet):
    def __init__(self, spec):
        super().__init__(spec)
        for n in spec["nodes"]:
            if n.get("dhcpSnooping") is not None:
                subprocess.run(["ip", "netns", "exec", self.ns[n["name"]], "nft", "-f", "-"],
                               input=ruleset(spec, n["name"], n["dhcpSnooping"].get("trusted", [])), text=True, check=True)
        time.sleep(1)

    def act(self, a):
        if a["do"] != "dhcpSnooping": return super().act(a)
        n = next(x for x in self.spec["nodes"] if x["name"] == a["switch"]); trusted = n["dhcpSnooping"].get("trusted", [])
        dropped = {}
        for p in ports_of(self.spec, a["switch"]):
            if p in trusted: continue
            js = json.loads(l3.sh("ip", "netns", "exec", self.ns[a["switch"]], "nft", "-j", "list", "counter", "bridge", "snoop", f"d_{p}"))
            c = next(o["counter"] for o in js["nftables"] if "counter" in o)["packets"]
            if c: dropped[p] = c
        return {"switch": a["switch"], "trusted": sorted(trusted), "dropped": dropped}


def kernel():
    spec = json.loads((HERE / f"{NAME}.json").read_text()); actions = json.loads((HERE / f"{NAME}.actions.json").read_text())
    k = SnoopNet(spec); out = []
    try:
        for a in actions:
            k.flush(); before = k.counters()
            r = k.act(a); time.sleep(a.get("settle", 1)); after = k.counters()
            out.append({"action": a, "result": r, "frames": {key: after[key] - before.get(key, 0) for key in after if after[key] - before.get(key, 0)}})
    finally:
        k.close()
    return out


def inner():
    l3.sh("mount", "-t", "tmpfs", "none", "/run")
    print(json.dumps(kernel()))


def main():
    need = ["unshare", "ip", "dnsmasq", "busybox", "nft"]
    if os.geteuid() != 0 or not all(shutil.which(x) for x in need):
        print(f"Needs root and {', '.join(need)}."); return 1 if os.environ.get("GITHUB_ACTIONS") else 0   # in CI a missing tool is an error, not a skip
    p = subprocess.run(["unshare", "-n", "-m", sys.executable, __file__, "--inner"], capture_output=True, text=True, timeout=600)
    if p.returncode:
        print("kernel side failed:\n" + p.stderr[-3000:]); l3.gh_note("error", "DHCP snooping kernel side failed", p.stderr[-6000:]); return 1
    kern = json.loads(p.stdout)
    eng = json.loads(l3.sh("node", str(ROOT / "engine/tools/run_spec.mjs"), str(HERE / f"{NAME}.json"), str(HERE / f"{NAME}.actions.json")))
    md = ["| Step | Result | Frames | Match |", "|---|---|---|---|"]; detail = {}
    for i, (e, k) in enumerate(zip(eng, kern)):
        a = e["action"]; r = e["result"]
        fd = {key: (e["frames"].get(key, 0), k["frames"].get(key, 0)) for key in sorted(set(e["frames"]) | set(k["frames"])) if e["frames"].get(key, 0) != k["frames"].get(key, 0)}
        ok = e["result"] == k["result"] and not fd
        if a["do"] == "dhcp": label = f'dhcp {a["src"]}'; res = f'{r["ip"]} from {r["server"]}' if r.get("ok") else r.get("error")
        else: label = f'drops on {a["switch"]}'; res = ", ".join(f"{p}: {c}" for p, c in r["dropped"].items()) or "none"
        md.append(f'| {i + 1}. {label} | {res} | {sum(e["frames"].values())} frames on {len(e["frames"])} cable directions | {"✓" if ok else "✗"} |')
        if not ok: detail[f"step {i + 1}: {label}"] = {"engine": e["result"], "kernel": k["result"], "frame_diffs": fd}
    if len(eng) != len(kern): detail["step count"] = {"engine": len(eng), "kernel": len(kern)}
    (HERE / "results.md").write_text("\n".join(md) + "\n"); (HERE / "mismatches.json").write_text(json.dumps(detail, indent=1))
    print("\n".join(md)); l3.gh_note("notice", "DHCP snooping results", "\n".join(md))
    if detail: print(json.dumps(detail, indent=1)[:6000]); l3.gh_note("error", "DHCP snooping engine vs Linux mismatch", json.dumps(detail))
    return 0 if not detail else 1


if __name__ == "__main__":
    if sys.argv[1:] == ["--inner"]: inner()
    else: sys.exit(main())
