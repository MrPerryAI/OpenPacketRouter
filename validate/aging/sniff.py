#!/usr/bin/env python3
"""Diagnostic: print one line per frame seen on an interface (time, src, dst, ethertype) to a file.
Used by run_kernel_aging.py to show which frames the kernel sent when counts differ."""
import socket, struct, sys, time
s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(3)); s.bind((sys.argv[1], 0))
out = open(sys.argv[2], "a", buffering=1); mac = lambda b: ":".join("%02x" % x for x in b)
while True:
    d = s.recv(4096); out.write(f"{time.monotonic():.3f} {mac(d[6:12])} > {mac(d[0:6])} type 0x{struct.unpack('!H', d[12:14])[0]:04x} len {len(d)}\n")
