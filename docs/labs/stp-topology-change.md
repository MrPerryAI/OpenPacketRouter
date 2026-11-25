# Spanning tree topology change

**What it shows:** What a switch does when a cable fails: it announces the change and shortens how long it remembers addresses.

**The network:** A triangle of three spanning-tree switches. A is on SW1, B is on SW2. The MAC aging time is 60 seconds.

## Run it

```bash
node engine/bin/openpacketrouter.mjs run examples/stp-topology-change/spec.json examples/stp-topology-change/actions.json --text
```

`--text` prints a readable report of what every device did. Without it you get JSON with the frames on each cable.

## Try it on a device console

Each device has a console. Open one with `node cli/bin/opr-cli.mjs examples/stp-topology-change/spec.json DEVICE`, or use the Studio. Type `?` at any point to see what is allowed.

On **SW1**:

```console
SW1> enable
SW1> show spanning-tree interface p1
```

- `enable`: Privileged mode.
- `show spanning-tree interface p1`: Roles and costs on one port.

## What to expect

- After the cable between SW1 and SW2 is cut, a TCN message travels toward the root, and the root sets the topology-change flag in its BPDUs for about ten seconds.
- While the flag is set, every switch ages out entries after only 4 seconds (the forward delay) instead of 60. B's entry becomes `stale`, so traffic to B is flooded until the new path is learned. After the flag clears, aging goes back to 60 seconds.

## Change something

Cut a different cable and see which switches have to re-learn.

More detail for the curious: [the lab's own README](../../examples/stp-topology-change/README.md).
