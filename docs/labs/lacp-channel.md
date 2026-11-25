# LACP port-channel

**What it shows:** Several cables between two switches behaving as one fat link, negotiated with LACP.

**The network:** SW1 and SW2 are joined by three cables (p3, p4, p5) bundled as Po1. Hosts A and C are on SW1, B and D on SW2.

## Run it

```bash
node engine/bin/openpacketrouter.mjs run examples/lacp-channel/spec.json examples/lacp-channel/actions.json --text
```

`--text` prints a readable report of what every device did. Without it you get JSON with the frames on each cable.

## Try it on a device console

Each device has a console. Open one with `node cli/bin/opr-cli.mjs examples/lacp-channel/spec.json DEVICE`, or use the Studio. Type `?` at any point to see what is allowed.

On **SW1**:

```console
SW1> enable
SW1> show etherchannel summary
```

- `enable`: Privileged mode.
- `show etherchannel summary`: The channel, its protocol, LACPDU rate and the state of each member.

## What to expect

- After the handshake all three members show `(P)`, bundled. The switches then treat Po1 as one port, so there is no loop.
- Each frame uses just one member, chosen from its MAC addresses; different host pairs can use different cables. If you cut one cable, the channel keeps working over the other two.

## Change something

Cut `SW1:p3` in the actions and see traffic spread over the two remaining cables.

More detail for the curious: [the lab's own README](../../examples/lacp-channel/README.md).
