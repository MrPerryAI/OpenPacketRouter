#!/usr/bin/env python3
"""Echo servers: tcp_server.py PORT [PORT...] — echo everything back, close when the client closes.
PORT 9 is a discard service: read and never answer (same close behavior)."""
import json, os, socket, sys, threading

KINDS = json.loads(os.environ.get("OPR_KINDS", "{}"))      # port -> "echo" | "discard" | "http"
PAGES = json.loads(os.environ.get("OPR_PAGES", "{}"))      # path -> page text, for "http" ports


def http(c):
    """The same bytes as engine/src/tcp.js httpResponse: HTTP/1.0, then close."""
    rx = b""
    while b"\r\n\r\n" not in rx:
        d = c.recv(65535)
        if not d: c.close(); return
        rx += d
    path = rx.decode().split(" ")[1]
    text = PAGES[path] if path in PAGES else "not found\n"
    status = "200 OK" if path in PAGES else "404 Not Found"
    c.sendall(f"HTTP/1.0 {status}\r\nContent-Type: text/plain\r\nContent-Length: {len(text)}\r\n\r\n{text}".encode())
    c.close()


def serve(c, discard=False):
    while True:
        d = c.recv(65535)
        if not d: break
        if not discard: c.sendall(d)
    c.close()


def listen(port):
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("0.0.0.0", port)); s.listen(16)
    while True:
        c, _ = s.accept(); threading.Thread(target=http if KINDS.get(str(port)) == "http" else serve, args=(c,) if KINDS.get(str(port)) == "http" else (c, port == 9 or KINDS.get(str(port)) == "discard"), daemon=True).start()


for p in sys.argv[1:]: threading.Thread(target=listen, args=(int(p),), daemon=True).start()
threading.Event().wait()
