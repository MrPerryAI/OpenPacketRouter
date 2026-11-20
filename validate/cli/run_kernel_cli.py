#!/usr/bin/env python3
"""The device CLI's Linux backend vs the engine: configure real Linux only from the CLI, compare frames.

    sudo python3 validate/cli/run_kernel_cli.py        (on a Mac: validate/docker/run.sh cli)

For each L3 validation network (validate/l3: fti-routed, fti-loop, fti-noreturn; validate/intervlan: roas, svi) this builds the cabling from the
spec (a network namespace per device, a veth pair per cable, nothing else), then configures every device ONLY with
the commands the CLI renders for it:

    node cli/bin/opr-cli.mjs SPEC DEVICE --render linux --lab-parity

(addresses, routes, forwarding, bridges, the DNS server, and the settings that pin the kernel to what the engine
models). One substitution: the engine's DNS is a simplified teaching protocol (JSON over UDP 53, see
validate/l3/dns_server.py), so the names the CLI renders for dnsmasq (`--host-record=NAME,IP`) are served by that
same stand-in instead of dnsmasq, exactly as validate/l3 does. It then runs the same checks as validate/l3 and
validate/l2 (results and the frame count on every cable direction; for spanning tree, every bridge's root, costs
and port roles and states after convergence, a cable cut and a restore) and compares them with the engine. If they match, the CLI's model -> Linux mapping builds the same network the engine runs.
"""
import json, os, shlex, shutil, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "validate" / "l3"))
import run_kernel_l3 as l3  # noqa: E402  (sh, nsx, no_ipv6, KernelNet.flush/counters/act/close, comparable, gh_note)

SPECS = ["fti-routed", "fti-loop", "fti-noreturn", "roas", "svi"]
DIRS = {"roas": "intervlan", "svi": "intervlan"}   # everything else is in validate/l3


def spec_path(name): return ROOT / "validate" / DIRS.get(name, "l3") / f"{name}.json"
def actions_path(name): return ROOT / "validate" / DIRS.get(name, "l3") / f"{name}.actions.json"
CLI = ROOT / "cli" / "bin" / "opr-cli.mjs"
DAEMONS = ("dnsmasq", "socat")


def rendered(spec_file, device):
    return [l for l in l3.sh("node", str(CLI), str(spec_file), device, "--render", "linux", "--lab-parity").splitlines() if l.strip()]


class CliNet(l3.KernelNet):
    """Cabling from the spec; configuration only from the CLI's Linux rendering."""
    def __init__(self, spec, spec_file):
        self.spec = spec; self.procs = []; self.ifmap = {}; self.commands = {}
        os.makedirs("/run/netns", exist_ok=True)
        l3.no_ipv6()  # the veth pairs are born here before they move into their namespaces
        self.ns = {n["name"]: "n-" + n["name"] for n in spec["nodes"]}
        for n in spec["nodes"]:
            ns = self.ns[n["name"]]; l3.sh("ip", "netns", "add", ns); l3.sh("ip", "-n", ns, "link", "set", "lo", "up")
        for k, (a, b, *_rest) in enumerate(spec["links"]):
            ta, tb = f"va{k}", f"vb{k}"
            l3.sh("ip", "link", "add", ta, "type", "veth", "peer", "name", tb)
            for tmp, ref in ((ta, a), (tb, b)):
                node, ifn = ref.split(":"); l3.sh("ip", "link", "set", tmp, "netns", self.ns[node], "name", ifn)
            self.ifmap[tuple(a.split(":"))] = b
            self.ifmap[tuple(b.split(":"))] = a
        for n in spec["nodes"]:
            ns, cmds = self.ns[n["name"]], rendered(spec_file, n["name"])
            self.commands[n["name"]] = cmds
            for c in cmds:
                words = shlex.split(c)
                if words[0] == "dnsmasq" and not any(w.startswith(("--dhcp-range", "--dhcp-relay")) for w in words):
                    records = dict(w.split("=", 1)[1].split(",", 1) for w in words if w.startswith("--host-record="))
                    self.procs.append(subprocess.Popen(["ip", "netns", "exec", ns, sys.executable, str(ROOT / "validate/l3/dns_server.py"), json.dumps(records)]))
                elif words[0] in DAEMONS:   # services run in the foreground under our control
                    extra = ["--keep-in-foreground", "--user=root"] if c.startswith("dnsmasq") else []
                    self.procs.append(subprocess.Popen(["ip", "netns", "exec", ns, *shlex.split(c), *extra], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
                else:
                    r = subprocess.run(["ip", "netns", "exec", ns, *shlex.split(c)], capture_output=True, text=True)
                    if r.returncode != 0: raise RuntimeError(f"{n['name']}: `{c}` failed: {r.stderr.strip()}")
        time.sleep(1)

    def flush(self):
        """l3's flush leaves a Layer 3 switch's own ARP cache alone; the engine clears it (validate/l2 does too)."""
        for n in self.spec["nodes"]:
            ns = self.ns[n["name"]]
            if n["kind"] == "switch": l3.sh("ip", "-n", ns, "link", "set", "br0", "type", "bridge", "fdb_flush")
            if n["kind"] != "switch" or n.get("ifaces"): l3.sh("ip", "-n", ns, "neigh", "flush", "all")


def kernel_run(name):
    spec_file = spec_path(name)
    spec = json.loads(spec_file.read_text()); actions = json.loads(actions_path(name).read_text())
    k = CliNet(spec, spec_file); out = []
    try:
        for a in actions:
            k.flush(); before = k.counters(); r = k.act(a); time.sleep(a.get("settle", 1)); after = k.counters()
            out.append({"action": a, "result": r, "frames": {key: after[key] - before.get(key, 0) for key in after if after[key] - before.get(key, 0)}})
    finally:
        k.close()
    return {"runs": out, "commands": k.commands}


def inner():
    l3.sh("mount", "-t", "tmpfs", "none", "/run")
    print(json.dumps({name: kernel_run(name) for name in SPECS}))


def main():
    if os.geteuid() != 0 or not shutil.which("unshare") or not shutil.which("ip") or not shutil.which("node"):
        print("Needs root, `unshare`, iproute2 and node. Skipping."); return 0
    p = subprocess.run(["unshare", "-n", "-m", sys.executable, __file__, "--inner"], capture_output=True, text=True, timeout=600)
    if p.returncode != 0:
        print(p.stderr[-4000:]); l3.gh_note("error", "CLI Linux backend: build failed", p.stderr[-4000:]); return 1
    kern = json.loads(p.stdout)
    rows, ok_all, detail = [], True, {}
    for name in SPECS:
        eng = json.loads(l3.sh("node", str(ROOT / "engine" / "tools" / "run_spec.mjs"), str(spec_path(name)), str(actions_path(name))))
        for e, k in zip(eng, kern[name]["runs"]):
            a = e["action"]; same = l3.comparable(e["result"]) == l3.comparable(k["result"])
            keys = sorted(set(e["frames"]) | set(k["frames"]))
            diffs = {key: (e["frames"].get(key, 0), k["frames"].get(key, 0)) for key in keys if e["frames"].get(key, 0) != k["frames"].get(key, 0)}
            ok = same and not diffs; ok_all &= ok
            what = f'{a["do"]} {a["src"]} → {a.get("dst", a.get("server"))}' + (f' ({a["name"]})' if "name" in a else "")
            rows.append((name, what, f'{sum(e["frames"].values())} frames on {len(e["frames"])} cable directions', "✓" if ok else "✗"))
            if not ok: detail[f"{name}: {what}"] = {"engine": l3.comparable(e["result"]), "kernel": l3.comparable(k["result"]), "frame_diffs": diffs}
    n_cmds = sum(len(c) for s in kern.values() for c in s["commands"].values())
    md = ["Each device configured only by `opr-cli SPEC DEVICE --render linux --lab-parity` "
          f"({n_cmds} commands across {sum(len(s['commands']) for s in kern.values())} devices); cabling from the spec. "
          "The rendered DNS names are served by validate/l3's stand-in server, because the engine's DNS is a simplified protocol.", "",
          "| Network | Action | Frames (engine = Linux, cable by cable?) | Match |", "|---|---|---|---|"]
    md += [f"| {a} | {b} | {c} | {d} |" for a, b, c, d in rows]
    example = kern["fti-routed"]["commands"]
    md += ["", "Example: what the CLI rendered for one router of fti-routed.", "", "```", *example[next(n["name"] for n in json.loads((ROOT / "validate/l3/fti-routed.json").read_text())["nodes"] if n["kind"] == "router")], "```"]
    (HERE / "results.md").write_text("\n".join(md) + "\n")
    (HERE / "mismatches.json").write_text(json.dumps(detail, indent=1))
    print("\n".join(md))
    if detail: print(json.dumps(detail, indent=1)[:4000]); l3.gh_note("error", "CLI Linux backend vs engine mismatch", json.dumps(detail))
    return 0 if ok_all else 1


if __name__ == "__main__":
    if sys.argv[1:] == ["--inner"]: inner()
    else: sys.exit(main())
