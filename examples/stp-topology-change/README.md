# Spanning tree topology change

Three switches in a triangle run spanning tree (fast timers: hello 1 s, max-age 6 s, forward delay 4 s). Hosts A (on SW1) and B (on SW2) talk, so the switches learn where they are, and each switch keeps a MAC entry for 60 seconds (`agingTime`).

```bash
node engine/bin/openpacketrouter.mjs run examples/stp-topology-change/spec.json examples/stp-topology-change/actions.json --text
```

What the actions do, looking at SW3:

| Step | What happens |
|---|---|
| wait 25 s | spanning tree converges and the topology-change flag from the start-up has cleared (`topologyChange: false`) |
| ping A → B, then `macTable` | SW3 has learned B and a neighbor's port MAC (switches learn the sender of every BPDU too); both are fresh |
| cut the cable SW1:p1 ↔ SW2:p1 | a port starts or stops carrying traffic, so a bridge sends a **TCN BPDU** up toward the root; the root acknowledges it and sets the topology-change flag in its BPDUs for forward delay + max-age (10 s) |
| 12 s later: `stp`, `macTable` | `topologyChange: true`: while it is set every switch keeps entries for only one forward delay (4 s, not 60 s). B's entry is 13 s old, so it is `stale`: it stays listed until the switch's cleanup runs, but it is expired |
| 20 s later | the flag has cleared and the aging time is back to 60 s |

Linux does not flush the table on a topology change; it shortens the aging time, and the engine does the same (validated against kernel bridges in `validate/tcn/`).
