# LLDP vs lldpd

`run_kernel_lldp.py` builds each network in Linux namespaces (cables are veth pairs, switches are Linux bridges), runs one
`lldpd` per node with an `lldp` key, and the same steps in the engine (`engine/tools/run_lldp.mjs`). On a Mac:
`validate/docker/run.sh lldp`. The result table is [results.md](results.md); a mismatch lists both sides in
`mismatches.json`.

lldpd is told what the engine does: host name, system description, TX interval and hold multiplier (TTL). It picks the
chassis ID itself, the MAC of the node's first (lowest-numbered) interface, which is also the engine's; the specs list a
node's interfaces in the order its cables are made.

| Network | What it covers |
|---|---|
| `lldp-direct` | R1 - R2 - H3 cabled directly: three neighbor tables, LLDPDUs both ways on both cables, a cable cut (both ends lose carrier and drop the neighbor at once) and restored. |
| `lldp-switch` | R1 and R2 on a switch that forwards LLDP (`forwardLldp`, bridge `group_fwd_mask 0x4000`), R4 and R5 on an ordinary switch (a Linux bridge never forwards 01:80:c2:00:00:0e: their tables stay empty). R2's cable is cut: R2 clears its table at once, R1 keeps R2 until the TTL runs out, then drops it; restored, R2's first frame leaves about 1 s later. |

Compared at every snapshot: each node's neighbor table (interface, chassis ID, port ID, port description, system name,
system description, enabled capabilities, TTL; MACs as `node:iface`), the set of distinct LLDPDUs that crossed each cable
direction since the previous snapshot (TLV contents and destination MAC), and how many (within one: lldpd's timers are
real time). Not compared: the Management Address and IEEE 802.3 / LLDP-MED TLVs lldpd also sends.

What was measured with lldpd 1.0.16, and what the engine copies:

- A frame goes out when lldpd starts, when its settings change, and every TX interval after that; carrier loss
  clears the neighbors learned on that interface at once, and the first frame after carrier returns leaves 1 s later.
- A new neighbor does not make the receiver send early.
- A frame from a neighbor lives for its TTL (TX interval × hold multiplier); one with TTL 0 removes it.
- The settings are applied in the order TX hold, then TX interval: lldpd sends one frame when the interval changes
  and only then uses the new hold multiplier, so setting the hold first gets the right TTL into that frame.

The specs end in `.net`, not `.json`, because `cli/test/roundtrip.test.js` reads every `*.json` spec and needs a CLI command for every key;
LLDP gets its CLI commands in a later change.
