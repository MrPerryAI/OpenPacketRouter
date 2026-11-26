#!/usr/bin/env python3
"""Syslog receiver for the validation network: syslog_server.py FILE. Appends every UDP 514 datagram to FILE, one per line."""
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(("0.0.0.0", 514))
while True:
    d, _ = s.recvfrom(4096)
    with open(sys.argv[1], "a") as f: f.write(d.decode(errors="replace").rstrip("\n") + "\n"); f.flush()
