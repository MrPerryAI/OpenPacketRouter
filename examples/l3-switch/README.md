# Layer 3 switch (SVIs)

SW1 routes between VLANs itself. Its *switched virtual interfaces* `vlan10`, `vlan20` and `vlan30` are the gateways for those VLANs (10.0.N.1/24), and a static route sends 10.9.0.0/24 to router R, which is attached on VLAN 30. SW2 is a plain VLAN switch on a trunk carrying VLANs 10 and 20.

```bash
node engine/bin/openpacketrouter.mjs run examples/l3-switch/spec.json examples/l3-switch/actions.json --text
node cli/bin/opr-cli.mjs examples/l3-switch/spec.json SW1 -c enable -c "show vlan brief" -c "show ip route"
```

| Action | Result | Why |
|---|---|---|
| A → B, A → D, C → D | work | the switch routes between VLANs 10 and 20 through its SVIs |
| A → C | works | same VLAN, switched |
| D → 10.9.0.10 | works | via `vlan20`, the static route, then R |
| traceroute C → 10.9.0.10 | two router hops | SW1's SVI (10.0.10.1), then R (10.0.30.2) |
| SW1 → 10.9.0.10 | works | the switch itself can ping, using its routing table |
| B → 10.0.10.1 | works | an SVI answers pings like any router interface |
| A → 10.0.20.99 | host unreachable | no one answers ARP |
| A → 10.8.0.1 | net unreachable | no route |

In the CLI, `interface vlan10` creates an SVI. `show vlan brief` shows each VLAN with its SVI, and `show ip route` and `show arp` work on a Layer 3 switch.
