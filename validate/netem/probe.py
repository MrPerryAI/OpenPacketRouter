#!/usr/bin/env python3
"""Probe: which of 12 UDP datagrams survive tc netem `loss gemodel` with all-or-nothing probabilities (CI only, needs root)."""
import json, os, socket, subprocess, sys, time

def sh(*a, **k): return subprocess.run(a, check=True, capture_output=True, text=True, **k).stdout

def run(params):
    ns = "np"; sh("ip", "netns", "add", ns)
    try:
        sh("ip", "link", "add", "v0", "type", "veth", "peer", "name", "v1", "netns", ns)
        sh("ip", "addr", "add", "10.9.0.1/24", "dev", "v0"); sh("ip", "link", "set", "v0", "up")
        sh("ip", "netns", "exec", ns, "ip", "addr", "add", "10.9.0.2/24", "dev", "v1"); sh("ip", "netns", "exec", ns, "ip", "link", "set", "v1", "up")
        sh("ip", "neigh", "replace", "10.9.0.2", "lladdr", sh("ip", "netns", "exec", ns, "cat", "/sys/class/net/v1/address").strip(), "dev", "v0", "nud", "permanent")
        sh("tc", "qdisc", "add", "dev", "v0", "root", "netem", "loss", "gemodel", *params)
        recv = subprocess.Popen(["ip", "netns", "exec", ns, "python3", "-c", """
import socket,sys,time
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.bind(("10.9.0.2",9000)); s.settimeout(2.5); got=[]
try:
    while True: got.append(int(s.recv(10)))
except Exception: pass
print(got)"""], stdout=subprocess.PIPE, text=True)
        time.sleep(1)
        c = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        for i in range(12): c.sendto(str(i).encode(), ("10.9.0.2", 9000)); time.sleep(0.05)
        return recv.communicate()[0].strip()
    finally:
        subprocess.run(["ip", "netns", "del", ns], capture_output=True); subprocess.run(["ip", "link", "del", "v0"], capture_output=True)

CASES = [["100%", "100%", "100%", "0%"], ["100%", "100%", "0%", "100%"], ["100%", "0%", "100%", "0%"], ["100%", "0%", "0%", "100%"], ["0%", "100%", "100%", "100%"], ["0%", "0%", "0%", "100%"], ["0%", "0%", "100%", "0%"], ["100%", "100%", "100%", "100%"], ["100%", "100%", "0%", "0%"]]
lines = []
for p in CASES:
    r = run(p); lines.append(f"gemodel {' '.join(p)} -> {r}"); print(lines[-1], flush=True)
print("::notice title=netem probe::" + " | ".join(lines))
