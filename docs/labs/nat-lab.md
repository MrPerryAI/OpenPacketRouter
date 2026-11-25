# NAT on a router

**What it shows:** Private addresses sharing one public address (overload), a fixed 1:1 mapping, and a port forward.

**The network:** Inside hosts A, B, W (10.1.0.0/24) reach S (203.0.113.50) through R, whose outside address is 203.0.113.1.

## Run it

```bash
node engine/bin/openpacketrouter.mjs run examples/nat-lab/spec.json examples/nat-lab/actions.json --text
```

`--text` prints a readable report of what every device did. Without it you get JSON with the frames on each cable.

## Try it on a device console

Each device has a console. Open one with `node cli/bin/opr-cli.mjs examples/nat-lab/spec.json DEVICE`, or use the Studio. Type `?` at any point to see what is allowed.

On **R**:

```console
R> enable
R> show ip nat translations
```

- `enable`: Privileged mode.
- `show ip nat translations`: The fixed mappings (A and the port forward to W).

On **B**:

```console
B> ping 203.0.113.50
```

- `ping 203.0.113.50`: Works; S sees 203.0.113.1, not B's private address.

## What to expect

- B and W leave as 203.0.113.1, with different source ports telling the flows apart. A always appears as 203.0.113.10, in both directions.
- S can start a conversation to 203.0.113.10, or to 203.0.113.1 port 8080 (forwarded to W's web server).

## Change something

Remove the static entry for A: A then shares the overload address like the others.

More detail for the curious: [the lab's own README](../../examples/nat-lab/README.md).
