# RIPv2 on a chain of three routers

H1 — R1 — R2 — R3 — H3. The routers learn each other's networks with RIPv2 (multicast updates every 5 s, split horizon with poisoned reverse, triggered updates; timers are shortened: timeout 15 s, garbage collection 10 s). R1's host LAN is passive.

```bash
node engine/bin/openpacketrouter.mjs run examples/rip-chain/spec.json examples/rip-chain/actions.json --text
```

| Step | What to see |
|---|---|
| after 14 s | `ripRoute` shows 10.3.0.0/24 at R1 with metric 3, R2 metric 2, R3 connected (1). The ping works. |
| R2–R3 cable cut | A triggered update poisons the route at once: metric 16 (= infinity). The ping gets `net unreachable`. |
| 30 s later | The poisoned routes were garbage collected: `null` (no route at all). |
| cable restored | Routes come back after the next updates; the ping works again. |

This matches FRRouting ripd on tables and on RIP packets on every cable ([validate/rip/results.md](../../validate/rip/results.md)). See also [count-to-infinity](../count-to-infinity/README.md).
