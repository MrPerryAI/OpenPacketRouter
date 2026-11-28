# RIPng on a chain of routers

**What it shows:** How routers learn IPv6 prefixes from each other with RIPng, and what happens to a route when its cable is cut and later restored.

**The network:** H1 - R1 - R2 - R3 - H3. H1 is on `2001:db8:1::/64`, H3 on `2001:db8:3::/64`, and the routers share `2001:db8:12::/64` and `2001:db8:23::/64`. All three routers run RIPng with an update every 5 s.

## Run it

```bash
node engine/bin/openpacketrouter.mjs run examples/ripng-chain/spec.json examples/ripng-chain/actions.json --text
```

`--text` prints a readable report of what every device did, including each RIPng update on the wire.

## Try it on a device console

Open a console with `node cli/bin/opr-cli.mjs examples/ripng-chain/spec.json DEVICE`, or use the Studio. Type `?` at any point to see what is allowed. The console starts after the routers have converged, so the learned routes are already there.

On **R1**:

```console
R1> enable
R1> show ipv6 route
R1> show ipv6 ripng
R1> show running-config
```

- `enable`: Privileged mode.
- `show ipv6 route`: Connected prefixes (`C`) and the prefixes learned by RIPng (`R`) with the next hop and metric. Add `| json` for machine-readable output.
- `show ipv6 ripng`: The RIPng table itself: code, prefix, next hop, metric and interface.
- `show running-config`: The `router ripng` block: networks, the passive interface and the timers.

On **H1**:

```console
H1> enable
H1> show ipv6 route
H1> show ipv6 neighbors
```

- `show ipv6 route`: A host only has its connected prefix and a default route.
- `show ipv6 neighbors`: Empty until H1 sends traffic and a neighbor answers.

## What to expect

- R1 learns `2001:db8:3::/64` with metric 3 (three hops away), R2 with metric 2. The first ping works.
- After the R2-R3 cable is cut, the route is advertised at metric 16 (unreachable) straight away. The ping fails with "no route", and later the route is deleted altogether.
- When the cable returns, the routes come back within a few update periods and the ping works again.

## Change something

Set `no passive-interface eth0` under `router ripng` on R1 to let it talk RIPng to H1, or use `timers basic 10 30 20` to slow the protocol down and watch the cut take longer to notice.

More detail for the curious: [the lab's own README](../../examples/ripng-chain/README.md).
