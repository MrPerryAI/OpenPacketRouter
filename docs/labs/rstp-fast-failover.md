# Rapid spanning tree: fast failover

**What it shows:** How rapid spanning tree (RSTP) replaces a failed link in a moment, using a blocked "alternate" port that is ready to take over.

**The network:** A triangle of three switches running rapid spanning tree. SW1 is the root. Host A is on SW2 (an edge port), host B on SW3.

## Run it

```bash
node engine/bin/openpacketrouter.mjs run examples/rstp-fast-failover/spec.json examples/rstp-fast-failover/actions.json --text
```

`--text` prints a readable report of what every device did. Without it you get JSON with the frames on each cable.

## Try it on a device console

Each device has a console. Open one with `node cli/bin/opr-cli.mjs examples/rstp-fast-failover/spec.json DEVICE`, or use the Studio. Type `?` at any point to see what is allowed.

On **SW3**:

```console
SW3> enable
SW3> show spanning-tree
SW3> show spanning-tree interface p1
SW3> show running-config
```

- `enable`: Privileged mode.
- `show spanning-tree`: The protocol in use, the root, and every port's role and state (add `| json` for machine-readable output).
- `show spanning-tree interface p1`: One port's role, cost and what it heard from its neighbour.
- `show running-config`: `spanning-tree mode rstp` is how the switch is told to run rapid spanning tree; `spanning-tree portfast` marks an edge port (SW2's `p3`).

## What to expect

- SW3 has a **root** port toward SW1 and an **alternate** port toward SW2. The alternate port is blocked, but it already knows the way to the root.
- When the cable between SW1 and SW3 is cut, the alternate port becomes the root port and forwards **at once**: the next ping works. Classic spanning tree would keep it blocked for up to 30 seconds.
- When the cable comes back, SW1 sends a *proposal* and SW3 answers with an *agreement*: the port is back in use without any timer.

## Change something

Switch SW3 back to classic spanning tree with `spanning-tree mode stp` (or remove `"mode": "rstp"` from its `stp` in the spec) and cut the same cable: now the port waits out its timers.

More detail for the curious: [the lab's own README](../../examples/rstp-fast-failover/README.md).
