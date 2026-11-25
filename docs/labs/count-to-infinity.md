# Count to infinity

**What it shows:** A classic routing failure: bad news and stale news chase each other around a loop of routers.

**The network:** A triangle R1, R2, R3; the LAN 10.3.0.0/24 hangs off R3. Triggered updates are off on purpose.

## Run it

```bash
node engine/bin/openpacketrouter.mjs run examples/count-to-infinity/spec.json examples/count-to-infinity/actions.json --text
```

`--text` prints a readable report of what every device did. Without it you get JSON with the frames on each cable.

## Try it on a device console

Each device has a console. Open one with `node cli/bin/opr-cli.mjs examples/count-to-infinity/spec.json DEVICE`, or use the Studio. Type `?` at any point to see what is allowed.

This lab is a teaching scenario for the engine only (there is no matching real-router test), and the routes appear during the run.

On **R1**:

```console
R1> enable
R1> show running-config
```

- `enable`: Privileged mode.
- `show running-config`: RIP with `no triggered-updates`.

## What to expect

- R3's LAN cable is cut. R3 poisons the route, but a neighbor's older update still offers it, so the false route circles the triangle with the metric rising by one each time until it reaches 16.
- Split horizon does not stop this: three routers in a loop can still fool each other.

## Change something

Set `triggered` to true in the spec and rerun: the loop disappears.

More detail for the curious: [the lab's own README](../../examples/count-to-infinity/README.md).
