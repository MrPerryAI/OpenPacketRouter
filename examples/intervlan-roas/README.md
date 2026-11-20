# Router on a stick

One router, one cable. R's single link to switch SW1 carries VLANs 10 and 20 tagged (an 802.1Q trunk). R has a *subinterface* for each VLAN, `eth0.10` (10.0.10.1/24) and `eth0.20` (10.0.20.1/24), and each is the default gateway for its VLAN. `eth0` itself is untagged and sits in the native VLAN 1 (host N, 10.0.1.0/24). SW1 and SW2 are joined by a trunk that also carries VLAN 30, but R has no subinterface for VLAN 30.

```bash
node engine/bin/openpacketrouter.mjs run examples/intervlan-roas/spec.json examples/intervlan-roas/actions.json --text
node cli/bin/opr-cli.mjs examples/intervlan-roas/spec.json R -c enable -c "show ip interface brief" -c "show ip route"
```

| Action | Result | Why |
|---|---|---|
| A (VLAN 10) → B (VLAN 20) | works | the frame goes up the trunk to R, which routes it out `eth0.20` |
| A → D, N → D | works | same, across SW2 or from the native VLAN |
| A → C | works | same VLAN, switched, no router needed |
| A → 10.0.20.1 | works | R answers on its VLAN 20 subinterface |
| traceroute C → B | one hop | R (10.0.10.1) is the only router between the VLANs |
| A → E (VLAN 30) | net unreachable | R has no route for 10.0.30.0/24 |
| A → 10.0.20.99 | host unreachable | nobody in VLAN 20 answers ARP for it |
| E → A | times out | E's VLAN has no router |

In the CLI, `interface eth0.10` creates the subinterface; the number after the dot is the VLAN. `show ip interface brief` lists it next to `eth0`.
