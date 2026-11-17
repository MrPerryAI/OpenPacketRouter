#!/usr/bin/env python3
"""Generate PTBuilder scripts (ptbuilder/*.js) from the configs/ folder.

PTBuilder (https://github.com/kimmknight/PTBuilder) is a Packet Tracer
extension that builds a topology from JavaScript using Packet Tracer's own
scripting API. Run this whenever a file in configs/ changes:

    python3 tools/make_ptbuilder.py

Each generated script builds one lab state from an EMPTY workspace:
    ptbuilder/build-1-baseline.js  -> end of Part 1
    ptbuilder/build-2-cutover.js   -> end of Part 2 step 5 (storm one ping away)
    ptbuilder/build-3-final.js     -> end of Part 4 (routed + hardened)
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CFG = ROOT / "configs"
OUT = ROOT / "ptbuilder"

# Lines that only make sense when pasting by hand. PTBuilder starts every
# configureIosDevice() call in global config mode and saves at the end.
SKIP = re.compile(r"^(enable|configure terminal|end|write memory)$")


def clean(text: str) -> str:
    lines = []
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith("!"):
            continue
        if SKIP.match(line.strip()):
            continue
        lines.append(line.strip() if not line.startswith(" ") else line)
    return "\n".join(lines)


def read(rel: str) -> str:
    return clean((CFG / rel).read_text())


def section(rel: str, device: str) -> str:
    """Pull the '---- On DEVICE ...' section out of a multi-device file."""
    text = (CFG / rel).read_text()
    parts = re.split(r"^! ---- On (\S+).*$", text, flags=re.M)
    for name, body in zip(parts[1::2], parts[2::2]):
        if name == device:
            return clean(body)
    raise KeyError(f"{device} not found in {rel}")


# ---------------------------------------------------------------- layout
DEVICES = {
    # name: (model, x, y)
    "NOC-SW": ("3560-24PS", 500, 80),
    "NOC-MON": ("PC-PT", 680, 40),
    "ZAB-SW": ("2960-24TT", 180, 300),
    "ZAB-RADAR": ("PC-PT", 60, 200),
    "ZAB-VOICE": ("PC-PT", 60, 380),
    "ZFW-SW": ("2960-24TT", 500, 360),
    "ZFW-RADAR": ("PC-PT", 420, 480),
    "ZFW-VOICE": ("PC-PT", 580, 480),
    "ZME-SW": ("2960-24TT", 820, 300),
    "ZME-RADAR": ("PC-PT", 940, 200),
    "ZME-VOICE": ("PC-PT", 940, 380),
    "AMA-SW": ("2960-24TT", 180, 520),
    "AMA-RADAR": ("Server-PT", 180, 640),
    "ELD-OLD": ("2960-24TT", 820, 560),
    "ELD-RADIO": ("Server-PT", 820, 680),
    "ELD-NEW": ("2960-24TT", 1080, 560),
    "ELD-RTR": ("2911", 1080, 420),
}

BASE_DEVICES = [d for d in DEVICES if d not in ("ELD-NEW", "ELD-RTR")]

LINKS_BASE = [
    ("NOC-SW", "FastEthernet0/1", "ZFW-SW", "FastEthernet0/1", "cross"),
    ("NOC-SW", "FastEthernet0/2", "ZME-SW", "FastEthernet0/1", "cross"),
    ("NOC-SW", "FastEthernet0/3", "ZAB-SW", "FastEthernet0/1", "cross"),
    ("ZFW-SW", "FastEthernet0/2", "ZME-SW", "FastEthernet0/2", "cross"),
    ("ZME-SW", "FastEthernet0/3", "ZAB-SW", "FastEthernet0/2", "cross"),
    ("ZAB-SW", "FastEthernet0/4", "AMA-SW", "FastEthernet0/1", "cross"),
    ("NOC-SW", "FastEthernet0/10", "NOC-MON", "FastEthernet0", "straight"),
    ("ZFW-SW", "FastEthernet0/10", "ZFW-RADAR", "FastEthernet0", "straight"),
    ("ZFW-SW", "FastEthernet0/11", "ZFW-VOICE", "FastEthernet0", "straight"),
    ("ZME-SW", "FastEthernet0/10", "ZME-RADAR", "FastEthernet0", "straight"),
    ("ZME-SW", "FastEthernet0/11", "ZME-VOICE", "FastEthernet0", "straight"),
    ("ZAB-SW", "FastEthernet0/10", "ZAB-RADAR", "FastEthernet0", "straight"),
    ("ZAB-SW", "FastEthernet0/11", "ZAB-VOICE", "FastEthernet0", "straight"),
    ("AMA-SW", "FastEthernet0/10", "AMA-RADAR", "FastEthernet0", "straight"),
    ("ELD-OLD", "FastEthernet0/10", "ELD-RADIO", "FastEthernet0", "straight"),
]
LINK_LEGACY_COPPER = ("ZME-SW", "FastEthernet0/4", "ELD-OLD", "FastEthernet0/1", "cross")
LINK_NEW_FIBER = ("NOC-SW", "GigabitEthernet0/1", "ELD-NEW", "GigabitEthernet0/1", "cross")
LINKS_XCONNECT = [
    ("ELD-NEW", "FastEthernet0/23", "ELD-OLD", "FastEthernet0/23", "cross"),
    ("ELD-NEW", "FastEthernet0/24", "ELD-OLD", "FastEthernet0/24", "cross"),
]
LINKS_REDESIGN = [
    ("ZME-SW", "FastEthernet0/4", "ELD-RTR", "GigabitEthernet0/0", "straight"),
    ("ELD-RTR", "GigabitEthernet0/1", "ELD-NEW", "GigabitEthernet0/1", "straight"),
]

HOSTS = {
    # name: (ip, mask, gateway or None)
    "NOC-MON": ("10.100.0.5", "255.255.255.0", None),
    "ZFW-RADAR": ("10.100.0.11", "255.255.255.0", None),
    "ZME-RADAR": ("10.100.0.12", "255.255.255.0", None),
    "ZAB-RADAR": ("10.100.0.13", "255.255.255.0", None),
    "AMA-RADAR": ("10.100.0.60", "255.255.255.0", None),
    "ZFW-VOICE": ("10.200.0.11", "255.255.255.0", "10.200.0.20"),
    "ZME-VOICE": ("10.200.0.12", "255.255.255.0", "10.200.0.20"),
    "ZAB-VOICE": ("10.200.0.13", "255.255.255.0", "10.200.0.20"),
    "ELD-RADIO": ("10.200.0.50", "255.255.255.0", None),
}
ELD_RADIO_FINAL = ("172.16.20.10", "255.255.255.0", "172.16.20.1")

BASELINE_CFG = {
    "NOC-SW": ["1-baseline/NOC-SW.txt"],
    "ZFW-SW": ["1-baseline/ZFW-SW.txt"],
    "ZME-SW": ["1-baseline/ZME-SW.txt"],
    "ZAB-SW": ["1-baseline/ZAB-SW.txt"],
    "ELD-OLD": ["1-baseline/ELD-OLD.txt"],
    "AMA-SW": ["1-baseline/AMA-SW.txt"],
}


def js(v) -> str:
    return json.dumps(v)


def script(title, devices, links, configs, hosts, notes):
    out = [
        f"// {title}",
        "// GENERATED by tools/make_ptbuilder.py from configs/ - do not edit by hand.",
        "// How to use: Packet Tracer > File > New, then Extensions > Builder Code Editor,",
        "// paste this whole script, click Run. Wait until the status line says DONE.",
        "",
        "var problems = [];",
        "function check(ok, what) { if (ok === false) problems.push(what); }",
        "",
        "// ---- Devices",
    ]
    for d in devices:
        model, x, y = DEVICES[d]
        out.append(f"check(addDevice({js(d)}, {js(model)}, {x}, {y}), {js('addDevice ' + d)});")
    out += ["", "// ---- Cables"]
    for a, ap, b, bp, kind in links:
        out.append(
            f"check(addLink({js(a)}, {js(ap)}, {js(b)}, {js(bp)}, {js(kind)}), "
            f"{js(f'link {a} {ap} - {b} {bp}')});"
        )
    out += ["", "// ---- Device configuration (one call per config file, in lab order)"]
    for dev, chunks in configs.items():
        for label, body in chunks:
            out.append(f"// {dev} <- {label}")
            out.append(f"configureIosDevice({js(dev)}, {js(body)});")
    out += ["", "// ---- PCs and servers"]
    for h, (ip, mask, gw) in hosts.items():
        args = [js(h), "false", js(ip), js(mask)] + ([js(gw)] if gw else [])
        out.append(f"configurePcIp({', '.join(args)});")
    out += [
        "",
        "if (problems.length) {",
        "    var msg = 'FINISHED WITH PROBLEMS:\\n' + problems.join('\\n');",
        "} else {",
        f"    var msg = 'DONE. ' + {js(notes)};",
        "}",
        "try {",
        "    ipc.appWindow().showMessageBox('Builder' + ' '.repeat(100), msg, '', 2, 0x00000400, 0x00000400, 0x00000400);",
        "} catch (e) { console.log(msg); }",
        "",
    ]
    return "\n".join(out)


def cfg(pairs):
    """pairs: {device: [relpath or (label, text)]} -> {device: [(label, text)]}"""
    res = {}
    for dev, items in pairs.items():
        res[dev] = []
        for it in items:
            if isinstance(it, tuple):
                res[dev].append(it)
            else:
                res[dev].append((it, read(it)))
    return res


def main():
    OUT.mkdir(exist_ok=True)

    # 1. Baseline (end of Part 1)
    s1 = script(
        "FAA ground stop lab - BUILD 1: BASELINE (end of Part 1)",
        BASE_DEVICES,
        LINKS_BASE + [LINK_LEGACY_COPPER],
        cfg(BASELINE_CFG),
        HOSTS,
        "Fast-forward time ~30 s, then File > Save As pkt/faa-ftl-baseline.pkt",
    )

    # 2. Cutover (end of Part 2 step 5)
    c2 = dict(BASELINE_CFG)
    c2["ELD-OLD"] = c2["ELD-OLD"] + ["2-cutover/ELD-OLD-migration-prep.txt"]
    c2["ELD-NEW"] = ["2-cutover/ELD-NEW-vendor-template.txt"]
    s2 = script(
        "FAA ground stop lab - BUILD 2: CUTOVER (end of Part 2 step 5; storm is one ping away)",
        BASE_DEVICES + ["ELD-NEW"],
        LINKS_BASE + [LINK_LEGACY_COPPER, LINK_NEW_FIBER] + LINKS_XCONNECT,
        cfg(c2),
        HOSTS,
        "Do NOT ping yet. File > Save As pkt/faa-ftl-cutover.pkt",
    )

    # 3. Final (end of Part 4, hardened)
    rd = "4-redesign/switch-changes.txt"
    c3 = {
        "NOC-SW": ["1-baseline/NOC-SW.txt", (rd, section(rd, "NOC-SW:"))],
        "ZFW-SW": ["1-baseline/ZFW-SW.txt"],
        "ZME-SW": ["1-baseline/ZME-SW.txt", (rd, section(rd, "ZME-SW:"))],
        "ZAB-SW": ["1-baseline/ZAB-SW.txt"],
        "ELD-OLD": [
            "1-baseline/ELD-OLD.txt",
            "2-cutover/ELD-OLD-migration-prep.txt",
            "3-fix/3-HARDEN-ELD-OLD.txt",
            (rd, section(rd, "ELD-OLD:")),
        ],
        "AMA-SW": ["1-baseline/AMA-SW.txt", "3-fix/3-HARDEN-AMA-SW.txt"],
        "ELD-NEW": [
            "2-cutover/ELD-NEW-vendor-template.txt",
            "3-fix/3-HARDEN-ELD-NEW.txt",
            (rd, section(rd, "ELD-NEW:")),
        ],
        "ELD-RTR": ["4-redesign/ELD-RTR.txt"],
    }
    hosts3 = dict(HOSTS)
    hosts3["ELD-RADIO"] = ELD_RADIO_FINAL
    s3 = script(
        "FAA ground stop lab - BUILD 3: FINAL (end of Part 4; routed edge + hardened)",
        list(DEVICES),
        LINKS_BASE + LINKS_XCONNECT + LINKS_REDESIGN,
        cfg(c3),
        hosts3,
        "Fast-forward time ~30 s, then File > Save As pkt/faa-ftl-final.pkt",
    )

    for name, body in [
        ("build-1-baseline.js", s1),
        ("build-2-cutover.js", s2),
        ("build-3-final.js", s3),
    ]:
        (OUT / name).write_text(body)
        print("wrote", OUT / name)


if __name__ == "__main__":
    main()
