# A 1 Mbit bottleneck

**What it shows:** What happens when a fast sender meets a slow link with a small queue: frames get dropped.

**The network:** PC is cabled to a switch through a 1 Mbit/s link with a 4000-byte queue. SERVER is 10.0.0.2.

## Run it

```bash
node engine/bin/openpacketrouter.mjs run examples/bottleneck/spec.json examples/bottleneck/actions.json --text
```

`--text` prints a readable report of what every device did. Without it you get JSON with the frames on each cable.

## Try it on a device console

Each device has a console. Open one with `node cli/bin/opr-cli.mjs examples/bottleneck/spec.json DEVICE`, or use the Studio. Type `?` at any point to see what is allowed.

On **PC**:

```console
PC> ping 10.0.0.2
PC> show interfaces
```

- `ping 10.0.0.2`: A single ping fits easily: works.
- `show interfaces`: The shaping rate, burst and queue limit on the PC's port.

## What to expect

- A burst of three 1000-byte frames passes. A burst of twenty overflows the queue, and the run shows a `drops` entry with 15 frames lost at PC:eth0.
- UDP never resends, so lost frames are simply gone; this is why TCP needs retransmission.

## Change something

Raise the `limit` or `rate` of the link and watch the drops shrink.

More detail for the curious: [the lab's own README](../../examples/bottleneck/README.md).
