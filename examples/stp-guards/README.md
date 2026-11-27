# Spanning tree guards: BPDU guard and root guard

SW1 is the provider's switch and the root (priority 4096). Two ports carry a guard:

- **p1 (root guard)** faces a customer switch SW2 that claims to be a better root (priority 0). SW1 refuses to let p1 become its root port: the port stays in *listening* for as long as the better BPDUs keep arriving, and SW1 stays root. The customer side is cut off from SW1 until the claim stops.
- **p2 (BPDU guard)** faces a rogue mini-switch SW3 somebody plugged in. The first BPDU that arrives shuts the port down (`disabled`); a link flap brings it back, and the next BPDU shuts it again.

```bash
node engine/bin/openpacketrouter.mjs run examples/stp-guards/spec.json examples/stp-guards/actions.json --text
```

Spec keys: `stp.rootGuard` and `stp.bpduGuard` (`{"p1": true}`); CLI: `spanning-tree root-guard`, `spanning-tree bpdu-guard`. These are the Linux bridge port flags `root_block` and `guard`, checked against kernel bridges in `validate/l2` (`stp-rootguard`, `stp-bpduguard`).
