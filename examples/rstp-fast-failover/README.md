# Rapid spanning tree: fast failover

Three switches in a triangle run **rapid** spanning tree (802.1w, `mode: rstp`) with the default timers (hello 2 s, max age 20 s, forward delay 15 s). SW1 has the best bridge id (priority 4096), so it is the root. Host A is on SW2 (an edge port, set with `spanning-tree portfast`), host B on SW3 (found to be an edge port by itself after 3 s of silence).

```bash
node engine/bin/openpacketrouter.mjs run examples/rstp-fast-failover/spec.json examples/rstp-fast-failover/actions.json --text
```

| Step | What happens |
|---|---|
| wait 10 s, `stp` on SW3 | SW3's port toward SW1 is the **root** port; its port toward SW2 is an **alternate** port, blocked but ready |
| ping A → B | works, through SW1: A, SW2, SW1, SW3, B |
| cut the cable SW1-SW3 | the root port is gone; the alternate port becomes the root port and forwards **at once** (classic spanning tree would wait up to 2 x 15 s) |
| `stp`, ping | SW3's root port is now toward SW2, and the ping still works |
| cable back, wait, `stp` | SW1 proposes, SW3 agrees: the port is back in use with no timers, and the old roles return |

Rapid spanning tree is what Linux's `mstpd` runs (the kernel bridge itself only does classic spanning tree, `stp_state 1`). The engine follows its state machines and is checked against it in `validate/rstp/` (CI only: the kernel hands RSTP to mstpd only in the initial network namespace).
