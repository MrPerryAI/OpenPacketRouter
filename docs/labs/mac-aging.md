# MAC address aging

**What it shows:** A switch forgets a host that has been silent for the aging time, and floods traffic to it until it learns again.

**The network:** A and B are on SW1, C is on SW2, and SW1 and SW2 are cabled together. SW1 forgets after 5 s; SW2 after 12 s.

## Run it

```bash
node engine/bin/openpacketrouter.mjs run examples/mac-aging/spec.json examples/mac-aging/actions.json --text
```

`--text` prints a readable report of what every device did. Without it you get JSON with the frames on each cable.

## Try it on a device console

Each device has a console. Open one with `node cli/bin/opr-cli.mjs examples/mac-aging/spec.json DEVICE`, or use the Studio. Type `?` at any point to see what is allowed.

On **SW1**:

```console
SW1> enable
SW1> show mac address-table
```

- `enable`: Privileged mode.
- `show mac address-table`: Each learned address, its port and age (empty until frames have passed).

## What to expect

- After the first ping both switches know A and C. After 8 seconds of silence SW1's table is empty but SW2's still lists them.
- The second ping is flooded by SW1, so bystander B also receives a copy. SW2, which still remembers, sends it only toward C.

## Change something

Set SW1's aging time to 20 with `mac address-table aging-time 20` in configuration mode (or change `agingTime` in the spec): now SW1 still remembers after 8 seconds.

More detail for the curious: [the lab's own README](../../examples/mac-aging/README.md).
