"""Sniff one interface in a namespace: one line per LACPDU it sent or received ('out'/'in'), with the decoded fields.
usage: lacpsniff.py IFACE OUTFILE [T0]   (line: seconds-since-T0 dir actor(...) partner(...))"""
import socket, struct, sys, time
mac = lambda b: ":".join("%02x" % x for x in b)
def tlv(x):   # actor/partner information TLV body (20 bytes incl. type, len)
    return (struct.unpack("!H", x[2:4])[0], mac(x[4:10]), struct.unpack("!H", x[10:12])[0], struct.unpack("!H", x[12:14])[0], struct.unpack("!H", x[14:16])[0], x[16])
def main():
    s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(3)); s.bind((sys.argv[1], 0))
    t0 = float(sys.argv[3]) if len(sys.argv) > 3 else time.time()
    f = open(sys.argv[2], "w", buffering=1)
    while True:
        d, a = s.recvfrom(4096)
        if d[12:14] != b"\x88\x09" or d[14] != 1: continue
        p = d[14:]
        out = "out" if a[2] == 4 else "in"
        f.write(f"{time.time()-t0:7.3f} {out} src={mac(d[6:12])} actor={tlv(p[2:22])} partner={tlv(p[22:42])}\n")
main()
