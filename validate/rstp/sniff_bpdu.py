#!/usr/bin/env python3
"""One line per spanning-tree BPDU an interface SENDS: time and kind. Kinds: tcn; config (+tc, +tca) for a classic
configuration BPDU; rstp-XX for an RSTP BPDU, XX being its flags byte in hex (bit 0 TC, 1 proposal, 2-3 port role
(1 alternate/backup, 2 root, 3 designated), 4 learning, 5 forwarding, 6 agreement). Run in the initial namespace by run_kernel_rstp.py."""
import socket, sys, time
s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(3)); s.bind((sys.argv[1], 0))
out = open(sys.argv[2], "a", buffering=1)
while True:
    try: d, addr = s.recvfrom(4096)
    except OSError: continue
    if addr[2] != socket.PACKET_OUTGOING or d[0:6] != bytes.fromhex("0180c2000000") or len(d) < 21: continue
    if d[20] == 0x80: kind = "tcn"
    elif d[19] >= 2: kind = f"rstp-{d[21]:02x}"
    else: kind = "config" + ("+tc" if d[21] & 1 else "") + ("+tca" if d[21] & 0x80 else "")
    out.write(f"{time.monotonic():.3f} {kind}\n")
