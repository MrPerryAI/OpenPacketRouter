# Storm control

Host A is plugged into SW1 port `p1`, which limits broadcasts to 8 kbit/s with a 400-byte burst (`storm-control broadcast rate 8kbit burst 400`). A broadcast burst gets only its first frames through: the port's allowance runs out and the rest are dropped before the switch looks at them. The limit works like a bucket that refills at the rate; every broadcast frame takes its length out of the bucket (without the Ethernet header, as Linux's `tc police` counts it), and a frame that does not fit is dropped without taking anything.

```bash
node engine/bin/openpacketrouter.mjs run examples/storm-control/spec.json examples/storm-control/actions.json --text
```

| Step | What happens | Why |
|---|---|---|
| 10 broadcasts of 100 bytes from A | 3 reach B and C, 7 are dropped | each costs 128 bytes of the 400-byte bucket |
| wait 1 s | the bucket is full again | 1 s at 8 kbit/s refills more than the burst |
| ping A → B | works | the ARP broadcast and the unicast frames fit |

On the CLI, on SW1: `show storm-control` (add `| json`) lists each limit with the frames passed and dropped. Only broadcast is limited and compared against Linux; multicast limits are not modeled yet.
