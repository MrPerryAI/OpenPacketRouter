# Switch ring with no spanning tree

**What it shows:** What happens when switches are cabled in a circle and nothing stops frames going round it.

**The network:** SW1, SW2 and SW3 are cabled in a ring. PC1 (10.0.0.1) and PC2 (10.0.0.2) hang off it.

## Run it

```bash
node engine/bin/openpacketrouter.mjs run examples/loop-no-stp/spec.json examples/loop-no-stp/actions.json --text
```

`--text` prints a readable report of what every device did. Without it you get JSON with the frames on each cable.

## Try it on a device console

Each device has a console. Open one with `node cli/bin/opr-cli.mjs examples/loop-no-stp/spec.json DEVICE`, or use the Studio. Type `?` at any point to see what is allowed.

On **PC1**:

```console
PC1> ping 10.0.0.2
```

- `ping 10.0.0.2`: On the console this just reports a timeout: the ring is too busy to deliver anything.

## What to expect

- The ping fails. The run output shows the ring cables carrying more than 100,000 frames each in about a second and a half: one ARP broadcast was copied round the ring over and over (a broadcast storm).
- In the text report, look at the switches' MAC-table lines: each switch keeps hearing PC1 on two different ports at once, so its table flaps back and forth.

## Change something

Remove one of the three switch-to-switch links from `spec.json` and run again: with no loop there is no storm, and the ping works.

More detail for the curious: [the lab's own README](../../examples/loop-no-stp/README.md).
