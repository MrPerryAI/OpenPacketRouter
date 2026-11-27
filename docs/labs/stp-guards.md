# Spanning tree guards: BPDU guard and root guard

**What it shows:** How a switch keeps control of its spanning tree when a neighbour misbehaves: root guard refuses a better root, BPDU guard shuts a port that should never hear a switch.

**The network:** SW1 (the root) has a customer switch SW2 on `p1` (root guard) and a rogue mini-switch SW3 on `p2` (BPDU guard). Host A is on SW1, host B on SW2.

## Run it

```bash
node engine/bin/openpacketrouter.mjs run examples/stp-guards/spec.json examples/stp-guards/actions.json --text
```

`--text` prints a readable report of what every device did. Without it you get JSON with the frames on each cable.

## Try it on a device console

Open one with `node cli/bin/opr-cli.mjs examples/stp-guards/spec.json DEVICE`, or use the Studio. Type `?` at any point to see what is allowed.

On **SW1**:

```console
SW1> enable
SW1> show spanning-tree
SW1> show running-config
SW1> show interfaces p1 | json
```

- `show spanning-tree`: `p1` is in listening and `p2` is disabled.
- `show running-config`: `spanning-tree root-guard` under `p1`, `spanning-tree bpdu-guard` under `p2`.
- `show interfaces p1 | json`: the `stp` object has `rootGuard` and `bpduGuard` flags.

## What to expect

- SW1 stays the root; SW2 is not its root and `p1` never forwards, so the ping A to B fails.
- `p2` is disabled the moment SW3's first BPDU arrives. Cut and restore the cable: it shuts again.

## Change something

- Remove `rootGuard` from the spec: SW2 (priority 0) takes over as root and the ping works.
- Remove `bpduGuard`: SW3 joins the tree.
