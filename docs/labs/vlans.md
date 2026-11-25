# Two VLANs across a trunk

**What it shows:** How VLANs split one switch network into separate broadcast domains, and how one trunk cable carries several of them.

**The network:** SW1 and SW2 are joined by a trunk carrying VLAN 10 (sales) and VLAN 20 (labs). SALES1 and SALES2 are in VLAN 10, LABS1 and LABS2 in VLAN 20. All four use 10.0.0.0/24.

## Run it

```bash
node engine/bin/openpacketrouter.mjs run examples/vlans/spec.json examples/vlans/actions.json --text
```

`--text` prints a readable report of what every device did. Without it you get JSON with the frames on each cable.

## Try it on a device console

Each device has a console. Open one with `node cli/bin/opr-cli.mjs examples/vlans/spec.json DEVICE`, or use the Studio. Type `?` at any point to see what is allowed.

On **SW1**:

```console
SW1> enable
SW1> show vlan
```

- `enable`: Privileged mode.
- `show vlan`: Which ports are in which VLAN, and what the trunk carries.

On **SALES1**:

```console
SALES1> ping 10.0.0.3
SALES1> ping 10.0.0.2
```

- `ping 10.0.0.3`: Same VLAN across the trunk: works.
- `ping 10.0.0.2`: Different VLAN, same subnet: times out.

## What to expect

- Pings inside a VLAN work, even across the trunk. Pings between VLANs time out: the ARP broadcast asking "who has this address?" never leaves its VLAN.
- The hosts share a subnet but not a broadcast domain, which is why you need a router to connect VLANs (see intervlan-roas and l3-switch).

## Change something

Move SALES2 to VLAN 20 in the spec: SALES1 can no longer reach it, and LABS1 now can.

More detail for the curious: [the lab's own README](../../examples/vlans/README.md).
