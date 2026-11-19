# TCP client and server

CLIENT opens a TCP connection through router R1 to an echo server on port 7, sends 100 bytes, gets them back and closes.

```bash
node engine/bin/openpacketrouter.mjs run examples/tcp/spec.json examples/tcp/actions.json --text
```

Each result has a `wire` list: what the client saw on its cable, in order (`out` = sent, `in` = received).

| Action | Result | `wire` |
|---|---|---|
| to SERVER port 7, 100 bytes | echoed | `S`, `SA`, `A` (the three-way handshake), `PA 100` data out, `A`, `PA 100` data back, `A`, then `FA`, `FA`, `A` to close |
| to SERVER port 8 | `refused` | `S`, then `RA`: nobody listens, so the server answers RST+ACK |
| to BROKEN port 7 | `timeout` | `S` three times: the SYN is retransmitted after 1 s and 3 s; BROKEN gets the SYN but has no route back to the client, so its answer never arrives |

(`S` = SYN, `A` = ACK, `PA` = push+ACK data, `FA` = FIN+ACK, `R` = reset.)

**Try:** give BROKEN `"gw": "10.2.0.1"` and rerun: the third action now succeeds. This engine's TCP matches real Linux frame for frame ([validate/tcp/results.md](../../validate/tcp/results.md)); it has no windows, congestion control or data retransmission yet.
