# OSPF with three areas

**What it shows:** How OSPF splits a network into areas, how the border routers (ABRs) pass summaries between them.

**The network:** H1 - R1 - R2, then a switch joining R2, R3 and R4 (area 0), R4 - R5 - H5, and H3 behind R3. R2 and R4 are ABRs.

## Run it

```bash
node engine/bin/openpacketrouter.mjs run examples/ospf-areas/spec.json examples/ospf-areas/actions.json --text
```

`--text` prints a readable report of what every device did. Without it you get JSON with the frames on each cable.

## Try it on a device console

Open a console with `node cli/bin/opr-cli.mjs examples/ospf-areas/spec.json DEVICE`, or use the Studio. Type `?` at any point to see what is allowed.

OSPF routes are learned while the run's clock advances, so use the run command for the routing results; the console shows the configuration.

On **R2** (the ABR):

```console
R2> enable
R2> show running-config
R2> show ip route
```

- `show running-config`: the `router ospf` block with the area of each network.
- `show ip route`: only connected networks here; learned routes appear during a run.

## What to expect

- After about 25 seconds H1 and H5 can ping each other across two area borders.
- Cut the R1-R2 cable: area 1 is split off and the ping from H1 fails. Restore it and the ping works again.

## Change something

Change R5's network to a different area number and see that R4 and R5 no longer become neighbors.
