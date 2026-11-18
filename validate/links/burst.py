#!/usr/bin/env python3
"""Run inside a host's namespace: send COUNT UDP datagrams of SIZE payload bytes to DST:PORT back to back."""
import json, socket, sys

dst, port, count, size = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET, 32, 8 << 20)  # SO_SNDBUFFORCE (root): never block or fail on our own send buffer
payload = b"x" * size
sent = 0
for _ in range(count):
    s.sendto(payload, (dst, port)); sent += 1
print(json.dumps({"sent": sent}))
