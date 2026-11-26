#!/usr/bin/env python3
"""Run inside a host's network namespace: ping / traceroute / dns / udp, print JSON.
Uses raw ICMP sockets so it can set TTL and see ICMP errors and who sent them."""
import json, os, random, select, socket, struct, sys, time


def csum(b):
    b += b"\0" * (len(b) % 2)
    s = sum(struct.unpack("!%dH" % (len(b) // 2), b)); s = (s >> 16) + (s & 0xffff); s += s >> 16
    return ~s & 0xffff


def icmp_sock():
    return socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP)


ERR = {11: "time exceeded", 3: {0: "net unreachable", 1: "host unreachable", 2: "protocol unreachable", 3: "port unreachable", 13: "administratively prohibited"}}
err_name = lambda t, c: ERR[11] if t == 11 else ERR[3].get(c, "unreachable")


def ping(dst, ttl, timeout):
    s = icmp_sock(); s.setsockopt(socket.IPPROTO_IP, socket.IP_TTL, ttl)
    ident = random.randint(1, 0xffff)
    pkt = struct.pack("!BBHHH", 8, 0, 0, ident, 1) + b"openpacketrouter"
    pkt = pkt[:2] + struct.pack("!H", csum(pkt)) + pkt[4:]
    s.sendto(pkt, (dst, 0)); t0 = time.time(); end = t0 + timeout
    while time.time() < end:
        if not select.select([s], [], [], max(0, end - time.time()))[0]: break
        d, a = s.recvfrom(2048); ihl = (d[0] & 15) * 4; t, c = d[ihl], d[ihl + 1]
        if t == 0 and struct.unpack("!H", d[ihl + 4:ihl + 6])[0] == ident: return {"ok": True, "from": a[0], "rtt_ms": (time.time() - t0) * 1000}
        if t in (3, 11):
            inner = d[ihl + 8:]; iihl = (inner[0] & 15) * 4
            if inner[9] == 1 and struct.unpack("!H", inner[iihl + 4:iihl + 6])[0] == ident: return {"ok": False, "from": a[0], "error": err_name(t, c)}
    return {"ok": False, "error": "timeout"}


def traceroute(dst, max_hops):
    hops = []
    for ttl in range(1, max_hops + 1):
        r = ping(dst, ttl, 1.0)
        hops.append({"ttl": ttl, "from": r.get("from"), "kind": "reached" if r["ok"] else (r["error"] if r.get("from") else "no answer")})
        if r["ok"] or (r.get("error") not in ("time exceeded", "timeout")): break
    return {"reached": any(h["kind"] == "reached" for h in hops), "hops": hops}


def udp(dst, port, payload, timeout):
    raw = icmp_sock(); u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); u.bind(("0.0.0.0", 0)); sport = u.getsockname()[1]
    u.sendto(json.dumps(payload).encode(), (dst, port)); end = time.time() + timeout
    while time.time() < end:
        r, _, _ = select.select([u, raw], [], [], max(0, end - time.time()))
        if not r: break
        if u in r:
            try: d, a = u.recvfrom(2048); return {"ok": True, "from": a[0], "payload": json.loads(d)}
            except OSError: pass
        if raw in r:
            d, a = raw.recvfrom(2048); ihl = (d[0] & 15) * 4; t, c = d[ihl], d[ihl + 1]
            if t == 3:
                inner = d[ihl + 8:]; iihl = (inner[0] & 15) * 4
                if inner[9] == 17 and struct.unpack("!H", inner[iihl:iihl + 2])[0] == sport: return {"ok": False, "from": a[0], "error": err_name(t, c)}
    return {"ok": False, "error": "timeout"}


cmd = sys.argv[1]
if cmd == "ping": out = ping(sys.argv[2], int(sys.argv[3]), float(sys.argv[4]))
elif cmd == "traceroute": out = traceroute(sys.argv[2], int(sys.argv[3]))
elif cmd == "dns":
    r = udp(sys.argv[2], 53, {"q": sys.argv[3]}, 2.0)
    out = {"ok": True, "from": r["from"], "answer": r["payload"]["a"]} if r["ok"] else r
elif cmd == "udp": out = udp(sys.argv[2], int(sys.argv[3]), {"probe": True}, 2.0)
print(json.dumps(out))
