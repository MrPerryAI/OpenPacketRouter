#!/usr/bin/env python3
"""Run inside a client's namespace: connect, send SIZE bytes, read the echo, close, print JSON.
usage: tcp_probe.py IFACE DST PORT SIZE TIMEOUT
Also records every TCP segment on IFACE (AF_PACKET) as "out FLAGS [LEN]" / "in FLAGS [LEN]"."""
import json, select, socket, struct, sys, threading, time

iface, dst, port, size, timeout = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), float(sys.argv[5])
wire, times, stop = [], [], threading.Event()
t0 = time.time()


def flag_name(fl, plen):
    syn, ack, fin, rst, psh = fl & 2, fl & 16, fl & 1, fl & 4, fl & 8
    if rst: return "RA" if ack else "R"
    if syn: return "SA" if ack else "S"
    if fin: return "FA"
    if psh: return "PA"
    return "A"


def sniff(s):
    while not stop.is_set():
        if not select.select([s], [], [], 0.05)[0]: continue
        d, (_, _, pkttype, _, _) = s.recvfrom(65535)
        if d[12:14] != b"\x08\x00" or d[23] != 6: continue
        ihl = (d[14] & 15) * 4; total = struct.unpack("!H", d[16:18])[0]; t = 14 + ihl
        plen = total - ihl - (d[t + 12] >> 4) * 4
        wire.append(("out " if pkttype == 4 else "in ") + flag_name(d[t + 13], plen) + (f" {plen}" if plen else "")); times.append(round(time.time() - t0, 2))


s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(3)); s.bind((iface, 0))
th = threading.Thread(target=sniff, args=(s,), daemon=True); th.start(); time.sleep(0.1)
c = socket.socket(); c.settimeout(timeout)
try:
    c.connect((dst, port)); c.sendall(b"x" * size); got = b""
    while len(got) < size:
        d = c.recv(65535)
        if not d: break
        got += d
    c.close(); out = {"ok": True, "from": dst, "bytes": len(got)}
except ConnectionRefusedError: out = {"ok": False, "error": "refused", "from": dst}
except (socket.timeout, TimeoutError): out = {"ok": False, "error": "timeout"}
except OSError as e: out = {"ok": False, "error": f"os error {e.errno}"}
time.sleep(0.8); stop.set(); th.join()
out["wire"] = wire; out["times_s"] = times   # timing is informational, not compared
print(json.dumps(out))
