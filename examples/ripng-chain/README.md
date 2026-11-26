# RIPng on a chain of routers

The same chain as `rip-chain`, but for IPv6: H1 - R1 - R2 - R3 - H3. Every router runs RIPng (`router ripng`) with short timers (an update every 5 s, a route times out after 15 s). R1's host-facing interface is passive: R1 does not talk RIPng to H1.

The actions wait for the routers to learn each other's prefixes, ping H1 to H3, cut the R2-R3 cable, ping again (R1 and R2 have marked the route unreachable, metric 16, so the ping gets "no route"), restore the cable and ping a third time.

```bash
node engine/bin/openpacketrouter.mjs run examples/ripng-chain/spec.json examples/ripng-chain/actions.json --text
node cli/bin/opr-cli.mjs examples/ripng-chain/spec.json R1     # then: show ipv6 ripng
```

The engine is validated against FRRouting's `ripngd` in `validate/ripng`.
