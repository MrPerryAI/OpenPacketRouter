# DHCP snooping

SW has `ip dhcp snooping` on and trusts only port `p1`, where the real DHCP server SRV is plugged in. A rogue DHCP server ROGUE sits on `p3`, and PC1 and PC2 are DHCP clients on `p2` and `p4`.

```bash
node engine/bin/openpacketrouter.mjs run examples/dhcp-snooping/spec.json examples/dhcp-snooping/actions.json --text
```

| Step | What happens | Why |
|---|---|---|
| PC1 asks for an address | PC1 gets 10.0.0.100 from SRV | ROGUE answers the broadcast too, but its OFFER arrives on untrusted `p3` and SW drops it |
| the switch's counters | `p3` shows 1 dropped server message | only DHCP server messages (UDP port 67 to 68) are dropped; everything else on `p3` passes |
| PC2 asks next | no offer: SRV's one-address pool is empty | ROGUE would hand out an address, but every one of its offers is dropped (4 in total) |

Linux has no DHCP snooping feature; the engine's filtering is validated against nftables bridge rules that drop `udp sport 67 udp dport 68` on untrusted ports (`validate/dhcp-snooping/`). The binding table, dynamic ARP inspection and IP source guard are not modeled.
