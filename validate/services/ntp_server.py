#!/usr/bin/env python3
"""NTP server for the validation network: ntp_server.py FILE STRATUM. Answers every client query (mode 3) on UDP 123 at STRATUM and appends
"vn=V mode=M len=N" for each datagram it receives to FILE. Timestamps are the wall clock, so they are never compared with the engine's."""
import socket, struct, sys, time
LOG, STRATUM = sys.argv[1], int(sys.argv[2])
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(("0.0.0.0", 123))
ntp = lambda: struct.pack("!II", int(time.time()) + 2208988800, int((time.time() % 1) * 2**32))
while True:
    d, a = s.recvfrom(1024)
    vn, mode = (d[0] >> 3) & 7, d[0] & 7
    with open(LOG, "a") as f: f.write(f"vn={vn} mode={mode} len={len(d)}\n"); f.flush()
    if mode != 3 or len(d) < 48: continue
    now = ntp()
    s.sendto(struct.pack("!BBbb", (0 << 6) | (vn << 3) | 4, STRATUM, d[2], -20) + struct.pack("!II", 0, 0x10000) + b"LOCL" + now + d[40:48] + now + now, a)
