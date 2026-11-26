# Storm control

**What it shows:** A switch port that rate-limits broadcasts: a burst gets only its first frames through and the rest are dropped before the switch looks at them.

**The network:** Host A is plugged into SW1 port `p1`, which allows 8 kbit/s of broadcast with a 400-byte burst. B and C are on the other ports.

## Run it

```bash
node engine/bin/openpacketrouter.mjs run examples/storm-control/spec.json examples/storm-control/actions.json --text
```

`--text` prints a readable report of what every device did. Without it you get JSON with the frames on each cable.

## Try it on a device console

Each device has a console. Open one with `node cli/bin/opr-cli.mjs examples/storm-control/spec.json DEVICE`, or use the Studio. Type `?` at any point to see what is allowed.

On **SW1**:

```console
SW1> enable
SW1> show storm-control
SW1> show running-config
```

- `enable`: Privileged mode.
- `show storm-control`: Each limited port's rate, burst and how many broadcasts were dropped (add `| json` for machine-readable output).
- `show running-config`: The `storm-control broadcast` line on `p1`.

## What to expect

- A sends 10 broadcasts of 100 bytes in a row: only 3 reach B and C. Each frame takes 128 bytes out of the 400-byte bucket, and the bucket refills slowly at the rate.
- After a second of quiet the bucket has refilled enough that a ping's ARP broadcast gets through, so the ping works.

## Change something

Raise the rate or burst with `storm-control broadcast rate 100kbit burst 4000` on `p1`: more of the burst arrives. Unicast traffic is never limited.

More detail for the curious: [the lab's own README](../../examples/storm-control/README.md).
