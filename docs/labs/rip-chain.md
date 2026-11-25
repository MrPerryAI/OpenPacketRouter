# RIP on a chain of routers

**What it shows:** How routers learn routes from each other with RIPv2, and how a cut cable poisons them.

**The network:** H1 - R1 - R2 - R3 - H3. All three routers run RIP; updates every 5 s.

## Run it

```bash
node engine/bin/openpacketrouter.mjs run examples/rip-chain/spec.json examples/rip-chain/actions.json --text
```

`--text` prints a readable report of what every device did. Without it you get JSON with the frames on each cable.

## Try it on a device console

Each device has a console. Open one with `node cli/bin/opr-cli.mjs examples/rip-chain/spec.json DEVICE`, or use the Studio. Type `?` at any point to see what is allowed.

The RIP routes are learned while the run's clock advances, so use the run command for this lab; the console shows only the configuration.

On **R1**:

```console
R1> enable
R1> show running-config
R1> show ip route
```

- `enable`: Privileged mode.
- `show running-config`: The `router rip` block: networks and the passive interface.
- `show ip route`: Only connected networks here: learned routes appear during a run.

## What to expect

- After about 14 seconds R1 learns 10.3.0.0/24 with metric 3, R2 with metric 2. The ping from H1 to H3 works.
- Cut the R2-R3 cable: a triggered update sets the route to metric 16 (unreachable) at once and the ping gets net unreachable. Later the route is deleted. Restore the cable and the routes return.

## Change something

Change `splitHorizon` on a router and see how the updates change.

More detail for the curious: [the lab's own README](../../examples/rip-chain/README.md).
