#!/usr/bin/env python3
"""Echo servers: tcp_server.py PORT [PORT...] — echo everything back, close when the client closes.
PORT 9 is a discard service: read and never answer (same close behavior)."""
import socket, sys, threading, time


def serve(c, discard=False, delay=0):
    time.sleep(delay)      # PORT 10: a slow reader, nothing is read for one second (small receive buffer)
    while True:
        d = c.recv(65535)
        if not d: break
        if not discard: c.sendall(d)
    c.close()


def listen(port):
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    if port == 10: s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
    s.bind(("0.0.0.0", port)); s.listen(16)
    while True:
        c, _ = s.accept(); threading.Thread(target=serve, args=(c, port in (9, 10), 1.0 if port == 10 else 0), daemon=True).start()


for p in sys.argv[1:]: threading.Thread(target=listen, args=(int(p),), daemon=True).start()
threading.Event().wait()
