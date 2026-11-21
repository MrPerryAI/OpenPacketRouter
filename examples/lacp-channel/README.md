# LACP port-channel

Two switches joined by three cables. Without link aggregation the switches would see a loop; with it, `SW1:p3-p5` and `SW2:p3-p5` act as **one logical port, Po1**, negotiated with LACP (IEEE 802.3ad, a Linux bond in `802.3ad` mode). SW1 asks its peer for slow LACPDUs (every 30 s), SW2 for fast ones (every second): `"rate": "fast"` in the spec, `lacp rate fast` on `interface Po1`.

```bash
node engine/bin/openpacketrouter.mjs run examples/lacp-channel/spec.json examples/lacp-channel/actions.json --text
```

| Step | What happens | Why |
|---|---|---|
| wait 6 s | every member goes through the LACP handshake (state bytes 0xc5, 0x05, 0x0d, 0x3d) and ends *bundled* | the 2 s wait-while timer, then both ends report in-sync, collecting and distributing |
| ping A → B, C → D | each frame crosses **one** of the three cables, picked by `last byte of destination MAC xor last byte of source MAC xor EtherType` modulo the number of members | the Linux `xmit_hash_policy layer2` default; the MAC table lists B and D on `Po1`, not on a cable |
| cut `SW1:p3`, wait | the channel keeps working with two members | a bond removes the dead slave from the hash |
| ping D → A | frames are spread over the two remaining cables | |

On the CLI: `channel-group 1 mode active` on each member port makes `Po1`, `lacp rate fast` goes on `interface Po1`, and `show etherchannel summary` lists the channel with each member's state (add `| json` for data).

Not modeled: LACP passive mode, `min-links`, hash policies other than layer2, a partner that is several different switches, and spanning tree on a port-channel (the spec validator refuses that combination).
