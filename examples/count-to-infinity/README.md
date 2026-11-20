# Count to infinity (teaching scenario)

A triangle of routers R1, R2, R3; LAN 10.3.0.0/24 hangs off R3. Split horizon is on, but **triggered updates are off**, which is a teaching knob (real routers send them). The R1–R2 cable is longer than the others (5 ms).

```bash
node engine/bin/openpacketrouter.mjs run examples/count-to-infinity/spec.json examples/count-to-infinity/actions.json --text
```

R3's LAN cable is cut. R3 poisons the route (16), but R2's update, sent at nearly the same moment, still offers it and reaches R1 just after the bad news. R1 believes it and tells R3; R3 tells R2; the false route goes round the triangle, one hop per update, with its metric rising by one each time, until it reaches 16 (infinity) and everyone drops it. Watch the `ripRoute` results: metrics 3, 3, 4 ... 16, over many updates, while a ping would loop meanwhile.

Split horizon cannot stop this: no router sends a route back where it came from, but a loop of three routers still works. The fix is triggered updates (and, in larger networks, hold-down or path-vector protocols). Turn `"triggered"` to `true` in the spec and rerun: the loop disappears. This scenario is engine-only (not compared with Linux); the mechanisms it relies on are, see [rip-chain](../rip-chain/README.md).
