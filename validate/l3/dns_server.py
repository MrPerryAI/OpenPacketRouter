#!/usr/bin/env python3
"""Tiny DNS-like UDP server for the validation network: {"q": name} -> {"q": name, "a": ip|null}."""
import json, socket, sys
records = json.loads(sys.argv[1])
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(("0.0.0.0", 53))
while True:
    d, a = s.recvfrom(2048)
    q = json.loads(d).get("q")
    s.sendto(json.dumps({"q": q, "a": records.get(q)}).encode(), a)
