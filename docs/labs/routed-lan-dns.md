# Two LANs, a router and DNS

**What it shows:** The basics of routing: ARP for the gateway, forwarding between subnets, traceroute, and DNS.

**The network:** PC1 (10.0.0.10) and a DNS server (10.1.0.53) are on different subnets joined by R1.

## Run it

```bash
node engine/bin/openpacketrouter.mjs run examples/routed-lan-dns/spec.json examples/routed-lan-dns/actions.json --text
```

`--text` prints a readable report of what every device did. Without it you get JSON with the frames on each cable.

## Try it on a device console

Each device has a console. Open one with `node cli/bin/opr-cli.mjs examples/routed-lan-dns/spec.json DEVICE`, or use the Studio. Type `?` at any point to see what is allowed.

On **PC1**:

```console
PC1> ping 10.1.0.53
PC1> traceroute 10.1.0.53
```

- `ping 10.1.0.53`: Works across the router.
- `traceroute 10.1.0.53`: Two lines: the router, then the server.

On **R1**:

```console
R1> enable
R1> show ip route
R1> show arp
```

- `enable`: Privileged mode.
- `show ip route`: Both connected networks.
- `show arp`: Appears once R1 has talked to a neighbor.

## What to expect

- PC1 does not ARP for the server; it ARPs for its gateway, R1, and R1 does the rest. Traceroute shows R1 as hop 1 because the TTL runs out there.
- Pinging an address nobody has (10.1.0.99) fails: R1's ARP request goes unanswered.

## Change something

Delete `gw` from PC1 and ping again: the host does not know where to send traffic for another subnet.

More detail for the curious: [the lab's own README](../../examples/routed-lan-dns/README.md).
