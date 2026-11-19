# Two LANs, one router: ping, traceroute, DNS

PC1 (10.0.0.10) and the DNS server (10.1.0.53) are on different subnets joined by R1.

```bash
node engine/bin/openpacketrouter.mjs run examples/routed-lan-dns/spec.json examples/routed-lan-dns/actions.json --text
```

**Look for:**
- ping: PC1 ARPs for its gateway (not the server), R1 forwards, then ARPs on the far side.
- traceroute: hop 1 is R1 (`time exceeded`, TTL ran out there), hop 2 is the server.
- dns: PC1 asks the server for `dns.school.lan` and gets `10.1.0.53`.
- ping to 10.1.0.99: nobody has that address, so R1's ARP goes unanswered and the ping fails.
