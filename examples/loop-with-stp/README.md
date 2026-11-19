# Loop with spanning tree

The same ring, but each switch runs spanning tree (802.1D, real BPDUs). The switches elect SW1 root (lowest bridge ID), and SW3 blocks one port so the ring becomes a line.

```bash
node engine/bin/openpacketrouter.mjs run examples/loop-with-stp/spec.json examples/loop-with-stp/actions.json --text
```

The first action is a throwaway ping with `"settle": 12`: it just lets 12 simulated seconds pass while ports go listening → learning → forwarding. (Timers are shortened to hello 1 s, max age 6 s, forward delay 4 s; real defaults are 2/20/15 and take 30 s.) The second ping then works with only 19 frames in total, against about 300,000 in the loop lab.

**Look for:** in the text report, BPDU exchanges early on; later, `SW3` never forwards on the blocked port, so no traffic goes around the ring.
