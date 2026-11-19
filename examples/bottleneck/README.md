# A shaped bottleneck link

PC's cable to the switch is limited to 1 Mbit/s with a 3000-byte burst and a 4000-byte queue (`shape` on the link; modeled on Linux `tbf`). Frames beyond what the queue holds are dropped.

```bash
node engine/bin/openpacketrouter.mjs run examples/bottleneck/spec.json examples/bottleneck/actions.json --text
```

| Action | Result |
|---|---|
| burst of 3 × 1000 bytes | all delivered, nothing dropped |
| burst of 20 × 1000 bytes | the queue overflows: a `drops` entry shows 15 frames lost at `PC:eth0` |
| ping | works; the link is quiet again |

**Look for:** the `drops` field next to `frames` in the JSON result. UDP does not resend, so lost frames are simply gone, which is why TCP's retransmission matters.
