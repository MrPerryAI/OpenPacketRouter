#!/usr/bin/env python3
"""FRR backend proof for IPv4 static routes: the device CLI's FRR rendering, loaded into real FRR, gives the engine's routing table.

    sudo python3 validate/frr-static/run_frr_static.py        # on a Mac: validate/docker/run.sh frrstatic

The network is built like validate/l3 (namespaces, veths, bridges, addresses), except that no router gets its static routes or default
gateway from `ip route`: every router runs zebra + staticd, and its `ip route ...` lines come only from the CLI's FRR rendering
(`opr-cli SPEC DEVICE --render frr`). After the routes settle, `ip route` of every host and router (main table) is compared with the
engine's table (engine/tools/dump_routes.mjs): destination, next hop and interface, exactly. The routes staticd installed must also
carry zebra's static protocol, so the comparison cannot pass on routes that something else put there.
"""
import json, os, shutil, subprocess, sys, tempfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "validate" / "l3"))
import run_kernel_l3 as l3  # noqa: E402

SPECS = [str(Path("validate/l3/fti-routed.json"))]
FRR = "/usr/lib/frr"
STATIC_PROTOS = {"static", "196"}


class StaticNet(l3.KernelNet):
    def __init__(self, spec):
        self.full = spec
        bare = json.loads(json.dumps(spec))
        for n in bare["nodes"]:
            if n["kind"] == "router": n.pop("routes", None); n.pop("gw", None)
        super().__init__(bare)
        self.tmp = tempfile.mkdtemp(); os.chmod(self.tmp, 0o755); self.frr = {}
        routers = [n["name"] for n in spec["nodes"] if n["kind"] == "router" and (n.get("routes") or n.get("gw"))]
        sf = f"{self.tmp}/spec.json"; Path(sf).write_text(json.dumps(spec))
        for name in routers:
            out = subprocess.run(["node", str(ROOT / "cli/bin/opr-cli.mjs"), sf, name, "--render", "frr"], capture_output=True, text=True, check=True).stdout
            keep = [l for l in out.splitlines() if l.startswith("ip route ")]
            assert keep, f"{name}: the rendering has no ip route line:\n{out}"
            self.frr[name] = self.conf(name, keep)
        for name, d in self.frr.items():
            self.procs.append(subprocess.Popen(["ip", "netns", "exec", self.ns[name], f"{FRR}/zebra", "-f", f"{d}/zebra.conf", "-i", f"{d}/zebra.pid",
                                                "-z", f"{d}/zserv.api", "--vty_socket", d, "-P", "0"],
                                               stdout=open(f"{self.tmp}/zebra-{name}.log", "w"), stderr=subprocess.STDOUT))
        time.sleep(2)
        for name, d in self.frr.items():
            self.procs.append(subprocess.Popen(["ip", "netns", "exec", self.ns[name], f"{FRR}/staticd", "-i", f"{d}/staticd.pid",
                                                "-z", f"{d}/zserv.api", "--vty_socket", d, "-P", "0"],
                                               stdout=open(f"{self.tmp}/staticd-{name}.log", "w"), stderr=subprocess.STDOUT))
        time.sleep(1)
        for name, d in self.frr.items():   # staticd takes its configuration through vtysh
            r = subprocess.run(["ip", "netns", "exec", self.ns[name], "vtysh", "--vty_socket", d, "-f", f"{d}/staticd.conf"], capture_output=True, text=True)
            if r.returncode: raise RuntimeError(f"vtysh -f failed on {name}: {r.stdout[-800:]}{r.stderr[-800:]}")
        time.sleep(2)

    def conf(self, name, routes):
        d = f"/run/frr/opr-{os.path.basename(self.tmp)}-{name}"; os.makedirs(d, exist_ok=True)
        Path(f"{d}/zebra.conf").write_text(f"hostname {name}\n")
        Path(f"{d}/staticd.conf").write_text("\n".join([f"hostname {name}", *routes]) + "\n")
        shutil.chown("/run/frr", "frr", "frr"); os.chmod("/run/frr", 0o775)
        shutil.chown(d, "frr", "frr"); os.chmod(d, 0o775)
        for f in os.listdir(d): shutil.chown(f"{d}/{f}", "frr", "frr"); os.chmod(f"{d}/{f}", 0o666)
        return d

    def tables(self):
        out = {}
        for n in self.full["nodes"]:
            if n["kind"] == "switch": continue
            rows = json.loads(l3.nsx(self.ns[n["name"]], "ip", "-j", "-4", "route", "show") or "[]")
            out[n["name"]] = [{"dst": r["dst"], "via": r.get("gateway"), "dev": r["dev"], "protocol": r.get("protocol")} for r in rows]
        return out

    def close(self):
        super().close()


def inner():
    l3.sh("mount", "-t", "tmpfs", "none", "/run")
    res = {}
    for path in sys.argv[2:] or SPECS:
        k = StaticNet(json.loads((ROOT / path).read_text()))
        try: res[path] = k.tables()
        except Exception: raise
        finally:
            try: logs = {f: (Path(k.tmp) / f).read_text()[-1500:] for f in os.listdir(k.tmp) if f.endswith(".log")}
            except Exception: logs = {}
            k.close()
        res[path + " logs"] = logs
    print(json.dumps(res))


def main():
    need = ["unshare", "ip", "vtysh", f"{FRR}/zebra", f"{FRR}/staticd"]
    if os.geteuid() != 0 or not all(shutil.which(x) or os.path.exists(x) for x in need):
        print("Needs root, unshare, iproute2 and FRRouting (zebra, staticd, vtysh).")
        if os.environ.get("GITHUB_ACTIONS"): print("This check is required in CI: failing instead of skipping."); return 1
        print("Skipping."); return 0
    paths = sys.argv[1:] or SPECS
    kern = json.loads(subprocess.run(["unshare", "-n", "-m", sys.executable, __file__, "--inner", *paths], check=True, capture_output=True, text=True, timeout=600).stdout)
    rows, detail = [], {}
    for path in paths:
        eng = json.loads(l3.sh("node", str(ROOT / "engine" / "tools" / "dump_routes.mjs"), str(ROOT / path)))
        spec = json.loads((ROOT / path).read_text()); kt = kern[path]
        for n in spec["nodes"]:
            name = n["name"]
            if n["kind"] == "switch": continue
            k = sorted(({"dst": r["dst"], "via": r["via"], "dev": r["dev"]} for r in kt[name]), key=lambda r: (r["dst"], str(r["via"])))
            e = eng[name]
            ok = e == k
            if n["kind"] == "router":   # the static routes must be zebra's, not the harness's
                bad = [r for r in kt[name] if r["via"] and r["protocol"] not in STATIC_PROTOS]
                if bad: ok = False; detail[f"{path}: {name} protocol"] = {"not from staticd": bad}
            rows.append((path, name, f'{sum(1 for r in e if r["via"])} static + {sum(1 for r in e if not r["via"])} connected', "✓" if ok else "✗"))
            if e != k: detail[f"{path}: {name}"] = {"engine": e, "linux": k, "logs": kern.get(path + " logs", {})}
    md = ["| Network | Device | Engine routes (same in Linux with FRR staticd?) | Match |", "|---|---|---|---|"]
    md += [f"| {a} | {b} | {c} | {d} |" for a, b, c, d in rows]
    (HERE / "results.md").write_text("\n".join(md) + "\n")
    (HERE / "mismatches.json").write_text(json.dumps(detail, indent=1))
    print("\n".join(md))
    if detail: print(json.dumps(detail, indent=1)[:6000]); l3.gh_note("error", "Static routes: engine vs FRR staticd mismatch", json.dumps(detail)[:900])
    return 0 if not detail else 1


if __name__ == "__main__":
    if sys.argv[1:2] == ["--inner"]: inner()
    else:
        try: sys.exit(main())
        except subprocess.CalledProcessError as e:
            print(e.stdout[-3000:] if isinstance(e.stdout, str) else "", e.stderr[-3000:] if isinstance(e.stderr, str) else ""); raise
