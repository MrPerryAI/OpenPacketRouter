#!/usr/bin/env python3
"""Run inside one network namespace: count every frame each listed interface sends.

    sniff.py eth0 p1 p2 ...

Per interface it keeps: total frames sent, BPDUs sent (to 01:80:c2:00:00:00),
802.1Q-tagged frames per VLAN, and the last BPDU decoded. On each line "dump"
from stdin it prints the cumulative counts as one JSON line, with the interface's
own tx counter ("tx") read right after, as a cross-check that nothing was missed.
"""
import errno, json, select, socket, struct, sys

ETH_P_ALL, SOL_PACKET, PACKET_AUXDATA, PACKET_OUTGOING = 3, 263, 8, 4
TP_STATUS_VLAN_VALID = 1 << 4
STP_MAC = bytes.fromhex("0180c2000000")


def bid(b):
    return b[:2].hex() + "." + b[2:8].hex()


def decode_bpdu(d):
    src = ":".join(f"{x:02x}" for x in d[6:12])
    p = d[17:]  # after the 802.3 header (14 bytes) and LLC 42 42 03
    if p[3] == 0x80:
        return {"src": src, "type": "tcn"}
    flags = p[4]
    t = lambda off: struct.unpack("!H", p[off:off + 2])[0] / 256
    return {"src": src, "type": "config", "tc": bool(flags & 1), "tca": bool(flags & 0x80), "root": bid(p[5:13]),
            "cost": struct.unpack("!I", p[13:17])[0], "bridge": bid(p[17:25]), "port": "0x%04x" % struct.unpack("!H", p[25:27])[0],
            "age": int(t(27)), "maxAge": t(29), "hello": t(31), "fwdDelay": t(33)}


socks, stats = {}, {}
for ifn in sys.argv[1:]:
    s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(ETH_P_ALL))
    s.setsockopt(SOL_PACKET, PACKET_AUXDATA, 1)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8 << 20)
    s.bind((ifn, 0)); s.setblocking(False)
    socks[s] = ifn
    stats[ifn] = {"total": 0, "bpdu": 0, "tagged": {}, "last": None, "tx": 0}


def drain(s):
    st = stats[socks[s]]
    while True:
        try:
            d, anc, _flags, addr = s.recvmsg(65536, socket.CMSG_SPACE(20))
        except BlockingIOError:
            return
        except OSError as e:   # the interface went down (a cable was unplugged): keep listening
            if e.errno == errno.ENETDOWN: continue
            raise
        if addr[2] != PACKET_OUTGOING:
            continue
        st["total"] += 1
        vid = None
        for lvl, typ, data in anc:
            if lvl == SOL_PACKET and typ == PACKET_AUXDATA:
                status, _l, _sl, _m, _n, tci, _tpid = struct.unpack("IIIHHHH", data[:20])
                if status & TP_STATUS_VLAN_VALID:
                    vid = tci & 0xfff
        if vid is None and d[12:14] == b"\x81\x00":
            vid = struct.unpack("!H", d[14:16])[0] & 0xfff
        if vid is not None:
            st["tagged"][str(vid)] = st["tagged"].get(str(vid), 0) + 1
        if d[:6] == STP_MAC:
            st["bpdu"] += 1
            st["last"] = decode_bpdu(d)


print("ready", flush=True)
while True:
    r, _, _ = select.select(list(socks) + [sys.stdin], [], [])
    for s in r:
        if s is sys.stdin:
            line = sys.stdin.readline()
            if not line:
                sys.exit(0)
            for x in socks:   # drain, then read the kernel's own tx counter right away, to cross-check
                drain(x)
                with open(f"/sys/class/net/{socks[x]}/statistics/tx_packets") as f:
                    stats[socks[x]]["tx"] = int(f.read())
            print(json.dumps(stats), flush=True)
        else:
            drain(s)
