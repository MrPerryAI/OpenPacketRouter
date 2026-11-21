# NAT on a router

Inside LAN 10.1.0.0/24 (hosts A, B, W on a switch) — router R — outside LAN 203.0.113.0/24 with server S.
R's eth0 is `ip nat inside`, eth1 is `ip nat outside`, and it has three rules:

- **overload**: B and W (anything in 10.1.0.0/24 without a fixed address) leave as R's outside address 203.0.113.1; the source port tells the flows apart.
- **static 1:1**: A always appears as 203.0.113.10, in both directions. R answers ARP for that address on the outside.
- **port forward**: connections to 203.0.113.1 port 8080 go to the web server W on port 80.

```bash
node engine/bin/openpacketrouter.mjs run examples/nat-lab/spec.json examples/nat-lab/actions.json --text
node cli/bin/opr-cli.mjs examples/nat-lab/spec.json R      # then: show ip nat translations
```

| Step | What to see |
|---|---|
| ping, TCP B/W → S | work; S only ever sees 203.0.113.1. |
| ping A → S | S sees 203.0.113.10. |
| ping S → 203.0.113.10, TCP S → 203.0.113.1:8080 | work: the outside starts the conversation through a static mapping. |
| UDP to a closed port | S's "port unreachable" quotes the translated packet; R translates the quote back so B gets it. |
| ping S → 10.1.0.11 | fails: B has no mapping, and S has no route to a private address. |

Linux nftables (masquerade, snat, dnat) does the same on frames, pings, UDP and TCP ([validate/nat/results.md](../../validate/nat/results.md)). On R: `show ip nat translations`, `show ip nat statistics`.
