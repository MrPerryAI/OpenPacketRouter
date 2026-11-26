#!/usr/bin/env python3
"""SNTP client for the validation network: ntp_client.py HOST. One request (leap 3, version 4, like ntpdate), prints the answer as JSON."""
import json, socket, struct, sys
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(1); s.connect((sys.argv[1], 123))
try:
    s.send(bytes([(3 << 6) | (4 << 3) | 3, 0, 3, 0]) + bytes(44)); d = s.recv(1024)
    print(json.dumps({"ok": True, "from": sys.argv[1], "stratum": d[1], "leap": d[0] >> 6}))
except ConnectionRefusedError:
    print(json.dumps({"ok": False, "from": sys.argv[1], "error": "port unreachable"}))
except socket.timeout:
    print(json.dumps({"ok": False, "error": "no server"}))
