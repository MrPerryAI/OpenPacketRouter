# Loop with no spanning tree

Three switches cabled in a ring; PC1 pings PC2. The ping starts with an ARP broadcast ("who has 10.0.0.2?"). Each switch floods it to every other port, so the frame runs around the ring in both directions forever.

```bash
node engine/bin/openpacketrouter.mjs run examples/loop-no-stp/spec.json examples/loop-no-stp/actions.json --text
```

**Look for:** the `frames` counts in the JSON output. PC1 sent 3 frames; the busiest ring cables carry over 100,000 each within about a second and a half. The ping times out because the network is too busy to deliver anything. In the text report, `SW1 ... drop: ... lives on the port it came in on` lines show switches learning the same address on two ports: the MAC table flapping.

**Next:** [loop-with-stp](../loop-with-stp/) fixes this.
