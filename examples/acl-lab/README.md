# Access lists on a router

Host A — router R — server S. R filters with named lists applied to its interfaces:

- `eth0 in` (FROM-LAN): lets A reach the server's DNS, UDP 8000-9100, TCP 80, established TCP on 8080 and ping (echo request) toward the server LAN. Anything else hits the implicit deny.
- `eth1 out` (TO-SERVERS): refuses UDP 9000-9100, passes the rest.
- `eth0 out` (TO-LAN): lets only echo replies, DNS answers and TCP from ports 80-8080 back to A.

A denied packet is dropped and R tells the sender with ICMP "administratively prohibited" (type 3, code 13). The ICMP errors R makes itself are never filtered. Multicast and broadcast pass whatever the lists say.

```bash
node engine/bin/openpacketrouter.mjs run examples/acl-lab/spec.json examples/acl-lab/actions.json --text
```

| Step | What to see |
|---|---|
| ping, DNS A → S | work: echo request is allowed in, the reply is allowed out. |
| UDP 8000 | passes both lists, but the server's "port unreachable" cannot come back (TO-LAN allows no ICMP errors): timeout. |
| UDP 9000 | allowed in, refused by TO-SERVERS: R answers "administratively prohibited". |
| UDP 5000, ping R itself | not in FROM-LAN: implicit deny on the way in (even for packets to R). |
| TCP 80 | connects. TCP 7 and 8080 (a SYN is not "established"): the connect fails at once with an error. |

Linux nftables does the same on frames, pings, UDP and TCP connects ([validate/acl/results.md](../../validate/acl/results.md)). On R: `show access-lists`.
