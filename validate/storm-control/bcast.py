#!/usr/bin/env python3
"""Run inside a host's namespace: send COUNT UDP datagrams of SIZE payload bytes to DST:PORT back to back.
A limited broadcast (255.255.255.255) needs SO_BROADCAST and a device to leave by (there is no route for it): eth0."""
import json, socket, sys

dst, port, count, size = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET, 32, 8 << 20)   # SO_SNDBUFFORCE (root)
s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
if dst == "255.255.255.255": s.setsockopt(socket.SOL_SOCKET, 25, b"eth0\0")   # SO_BINDTODEVICE
payload = b"x" * size
for _ in range(count): s.sendto(payload, (dst, port))
print(json.dumps({"sent": count}))
