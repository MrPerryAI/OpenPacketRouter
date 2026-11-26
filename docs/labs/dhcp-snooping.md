# DHCP snooping

**What it shows:** A switch that only accepts DHCP server messages from the port the real server is plugged into, so a rogue DHCP server elsewhere on the LAN is ignored.

**The network:** SW trusts port `p1` (the real server SRV). A rogue server ROGUE is on `p3`. PC1 and PC2 are DHCP clients on `p2` and `p4`.

## Run it

```bash
node engine/bin/openpacketrouter.mjs run examples/dhcp-snooping/spec.json examples/dhcp-snooping/actions.json --text
```

`--text` prints a readable report of what every device did. Without it you get JSON with the frames on each cable.

## Try it on a device console

Each device has a console. Open one with `node cli/bin/opr-cli.mjs examples/dhcp-snooping/spec.json DEVICE`, or use the Studio. Type `?` at any point to see what is allowed.

On **SW**:

```console
SW> enable
SW> show ip dhcp snooping
SW> show running-config
```

- `enable`: Privileged mode.
- `show ip dhcp snooping`: Whether snooping is on, which ports are trusted and how many server messages were dropped (add `| json` for machine-readable output).
- `show running-config`: The `ip dhcp snooping` line and the `ip dhcp snooping trust` line on `p1`.

## What to expect

- PC1 gets 10.0.0.100 from SRV. ROGUE also answers, but its offer arrives on the untrusted port `p3` and is dropped.
- The drop counter for `p3` goes up each time ROGUE answers.
- PC2 finds SRV's one-address pool empty, and ROGUE's offers are dropped too, so PC2 gets nothing.

## Change something

Remove the trust from `p1` with `no ip dhcp snooping trust` in `interface p1` (or add `p3` to `trusted` in the spec) and run again: the offers of whichever server is untrusted are the ones that vanish.

More detail for the curious: [the lab's own README](../../examples/dhcp-snooping/README.md).
