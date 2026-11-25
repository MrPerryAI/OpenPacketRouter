#!/usr/bin/env python3
"""Run inside a host's network namespace: one ICMPv6 echo with a chosen hop limit; print JSON like validate/l3/probe.py.
    probe6.py ping DST HOPLIMIT TIMEOUT"""
import ipaddress, json, os, random, select, socket, struct, sys, time

NAMES = {(1, 0): "no route", (1, 1): "administratively prohibited", (1, 3): "address unreachable"}


def ping(dst, hl, timeout):
    s = socket.socket(socket.AF_INET6, socket.SOCK_RAW, socket.IPPROTO_ICMPV6)
    s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_UNICAST_HOPS, hl)
    ident = random.randint(1, 0xffff)
    try:
        s.sendto(struct.pack("!BBHHH", 128, 0, 0, ident, 1) + b"openpacketrouter", (dst, 0, 0, 0))   # the kernel fills in the checksum
    except OSError:
        return {"ok": False, "error": "no route"}
    end = time.time() + timeout
    while time.time() < end:
        if not select.select([s], [], [], max(0, end - time.time()))[0]: break
        d, a = s.recvfrom(2048); t, c = d[0], d[1]; frm = ipaddress.ip_address(a[0].split("%")[0]).compressed
        if t == 129 and struct.unpack("!H", d[4:6])[0] == ident: return {"ok": True, "from": frm}
        if t in (1, 3) and len(d) >= 8 + 40 + 8:
            inner = d[8:]
            if inner[6] == 58 and inner[40] == 128 and struct.unpack("!H", inner[44:46])[0] == ident:
                return {"ok": False, "from": frm, "error": "time exceeded" if t == 3 else NAMES.get((t, c), "unreachable")}
    return {"ok": False, "error": "timeout"}


if sys.argv[1] == "ping": print(json.dumps(ping(sys.argv[2], int(sys.argv[3]), float(sys.argv[4]))))
