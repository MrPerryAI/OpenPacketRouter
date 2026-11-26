#!/usr/bin/env python3
"""SNTP server for the validation network: ntp_server.py STRATUM. Answers every client packet (mode 3) on UDP 123 in server mode."""
import socket, struct, sys, time
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(("0.0.0.0", 123))
EPOCH = 2208988800
def stamp(t): return struct.pack("!II", int(t) + EPOCH, int((t % 1) * 2**32))
while True:
    d, a = s.recvfrom(1024)
    if len(d) < 48 or d[0] & 7 != 3: continue
    now = time.time()
    s.sendto(struct.pack("!BBbb", (0 << 6) | (((d[0] >> 3) & 7) << 3) | 4, int(sys.argv[1]), d[2], -20) + bytes(12)
             + stamp(now) + d[40:48] + stamp(now) + stamp(now), a)
