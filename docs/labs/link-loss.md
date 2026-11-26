# A lossy, slow cable

**What it shows:** A cable with a 40 ms delay whose one end drops every second frame it sends, so pings time out and the result counts the drops.

**The network:** Hosts A and B are joined by one cable. A's end has the loss pattern `loss pattern 1 1 1 0`.

## Run it

```bash
node engine/bin/openpacketrouter.mjs run examples/link-loss/spec.json examples/link-loss/actions.json --text
```

`--text` prints a readable report of what every device did. Without it you get JSON with the frames on each cable.

## Try it on a device console

Each device has a console. Open one with `node cli/bin/opr-cli.mjs examples/link-loss/spec.json DEVICE`, or use the Studio. Type `?` at any point to see what is allowed.

On **A**:

```console
A> enable
A> show interfaces eth0
A> show running-config
```

- `enable`: Privileged mode.
- `show interfaces eth0`: The cable delay and the loss pattern (add `| json` for machine-readable output).
- `show running-config`: The `delay 40` and `loss pattern 1 1 1 0` lines on `eth0`.

## What to expect

- A's first frame (the ARP request) gets through and B answers. A's second frame (the ping) is lost, so the ping times out.
- Pinging from B fails the same way: A's answer is its second frame.

## Change something

Set `no loss` on A's `eth0` and the pings work, taking about 80 ms because of the delay. Change the delay with `delay 5`.

More detail for the curious: [the lab's own README](../../examples/link-loss/README.md).
