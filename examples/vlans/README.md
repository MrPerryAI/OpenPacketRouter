# VLANs and a trunk

Two switches share one cable (a trunk) that carries VLAN 10 and VLAN 20. All four hosts are in the same IP subnet, 10.0.0.0/24, but VLANs split them into separate broadcast domains.

```bash
node engine/bin/openpacketrouter.mjs run examples/vlans/spec.json examples/vlans/actions.json --text
```

| Ping | Result | Why |
|---|---|---|
| SALES1 → SALES2 | works | both VLAN 10, across the trunk |
| LABS1 → LABS2 | works | both VLAN 20, across the trunk |
| SALES1 → LABS1 | times out | different VLANs: the ARP broadcast never reaches the other VLAN |
| SALES1 → LABS2 | times out | same reason |

Getting between VLANs needs a router; that example will be added when the engine supports it.
