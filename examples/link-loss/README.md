# A lossy, slow cable

Hosts A and B are joined by a cable with a 40 ms delay. A's end of the cable drops every second frame it sends: the loss pattern is `loss pattern 1 1 1 0` (after a frame in the good state the next frame is in the bad state, and after a bad one it is good again; frames sent in the bad state are lost, frames sent in the good state get through).

A's first frame (the ARP request) gets through, so B answers; A's second frame (the ping itself) is lost, so the ping times out. Ping the other way and the same thing happens to A's answer. The result shows each cable's frame count and the drops on A's interface.

```bash
node engine/bin/openpacketrouter.mjs run examples/link-loss/spec.json examples/link-loss/actions.json
node cli/bin/opr-cli.mjs examples/link-loss/spec.json A     # then: show interfaces eth0
```

The cable's delay is set on either end with `delay 40`; the loss pattern is per end (`loss pattern TOBAD TOGOOD INBAD INGOOD`, each 0 or 1). Linux's random loss cannot be matched frame for frame, so only these all-or-nothing patterns are accepted; `validate/netem` checks them against `tc netem`.
