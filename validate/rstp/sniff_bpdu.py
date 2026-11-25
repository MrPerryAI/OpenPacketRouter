#!/usr/bin/env python3
"""One line per spanning-tree BPDU an interface SENDS: time, BPDU version, type, flags byte (RSTP: bit0 TC, 1 proposal,
2-3 port role, 4 learning, 5 forwarding, 6 agreement, 7 TCA). Run in the initial namespace by run_kernel_rstp.py."""
import socket, sys, time
s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(3)); s.bind((sys.argv[1], 0))
out = open(sys.argv[2], "a", buffering=1)
while True:
    try: d, addr = s.recvfrom(4096)
    except OSError: continue
    if addr[2] != socket.PACKET_OUTGOING or d[0:6] != bytes.fromhex("0180c2000000") or len(d) < 21: continue
    if d[20] == 0x80: out.write(f"{time.monotonic():.3f} 0 tcn 0\n")
    else: out.write(f"{time.monotonic():.3f} {d[19]} {d[20]} {d[21]:02x}\n")
