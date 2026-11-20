#!/usr/bin/env python3
"""Print one line per frame an interface SENDS: "data", or the kind of spanning-tree BPDU
(config, config+tc, config+tca, config+tc+tca, tcn) and the time. The validators count these per cable direction."""
import socket, sys, time
s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(3)); s.bind((sys.argv[1], 0))
out = open(sys.argv[2], "a", buffering=1)
while True:
    try: d, addr = s.recvfrom(4096)
    except OSError: continue   # ENETDOWN is reported once to a packet socket when its interface goes down; it listens again when the interface comes back
    if addr[2] != socket.PACKET_OUTGOING: continue
    if d[0:6] == bytes.fromhex("0180c2000000") and len(d) >= 21:
        if d[20] == 0x80: out.write(f"tcn {time.monotonic():.2f}\n")   # a TCN BPDU is only 4 bytes after the LLC header: no flags byte
        else: out.write("config" + ("+tc" if d[21] & 1 else "") + ("+tca" if d[21] & 0x80 else "") + f" {time.monotonic():.2f}\n")
    else: out.write(f"data {time.monotonic():.2f}\n")
