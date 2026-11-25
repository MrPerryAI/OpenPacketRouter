# Switch ring with spanning tree

**What it shows:** How spanning tree breaks a loop: it picks a root switch and blocks exactly enough ports to leave a tree.

**The network:** The same ring as loop-no-stp, but all three switches run spanning tree (with short timers so you do not wait long).

## Run it

```bash
node engine/bin/openpacketrouter.mjs run examples/loop-with-stp/spec.json examples/loop-with-stp/actions.json --text
```

`--text` prints a readable report of what every device did. Without it you get JSON with the frames on each cable.

## Try it on a device console

Each device has a console. Open one with `node cli/bin/opr-cli.mjs examples/loop-with-stp/spec.json DEVICE`, or use the Studio. Type `?` at any point to see what is allowed.

On **SW2**:

```console
SW2> enable
SW2> show spanning-tree
SW2> show spanning-tree interface p1
```

- `enable`: Privileged mode, where the show commands live.
- `show spanning-tree`: The bridge ID, the root ID, and each port's role and state.
- `show spanning-tree interface p1`: Everything one port knows about the root it follows.

On **PC1**:

```console
PC1> ping 10.0.0.2
```

- `ping 10.0.0.2`: Works: the ring is now a line.

## What to expect

- SW1 has the lowest bridge ID, so it becomes the root. On SW2 the port toward SW1 shows as `root` and `forwarding`.
- One port in the ring (on SW3) ends up `blocked`. It still hears BPDUs but passes no traffic, so frames cannot go round. The whole run moves only a few dozen frames instead of a storm.

## Change something

Change one switch's `stp.priority` in `spec.json` (lower wins) and run again: the root moves, and a different port gets blocked.

More detail for the curious: [the lab's own README](../../examples/loop-with-stp/README.md).
