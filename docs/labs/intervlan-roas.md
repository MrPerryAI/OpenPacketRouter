# Router on a stick

**What it shows:** One router, one cable, several VLANs: the router has a subinterface per VLAN and routes between them.

**The network:** R connects to SW1 with a single trunk. It has eth0.10 (10.0.10.1) and eth0.20 (10.0.20.1) as gateways for VLANs 10 and 20.

## Run it

```bash
node engine/bin/openpacketrouter.mjs run examples/intervlan-roas/spec.json examples/intervlan-roas/actions.json --text
```

`--text` prints a readable report of what every device did. Without it you get JSON with the frames on each cable.

## Try it on a device console

Each device has a console. Open one with `node cli/bin/opr-cli.mjs examples/intervlan-roas/spec.json DEVICE`, or use the Studio. Type `?` at any point to see what is allowed.

On **R**:

```console
R> enable
R> show ip interface brief
R> show ip route
```

- `enable`: Privileged mode.
- `show ip interface brief`: The main interface and its two VLAN subinterfaces.
- `show ip route`: Directly connected networks, one per VLAN.

On **A**:

```console
A> ping 10.0.20.12
```

- `ping 10.0.20.12`: Across VLANs, through the router: works.

## What to expect

- Hosts in different VLANs now reach each other because their frames go up the trunk to the router, which routes them back down the other VLAN.
- A host in VLAN 30 gets "net unreachable": the router has no interface in that VLAN.

## Change something

Add a subinterface for VLAN 30 to the router (and a trunk entry on the switches) and the unreachable host appears.

More detail for the curious: [the lab's own README](../../examples/intervlan-roas/README.md).
