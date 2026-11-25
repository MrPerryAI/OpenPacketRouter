# Layer 3 switch

**What it shows:** A switch that routes: virtual interfaces (SVIs) act as the gateways for each VLAN.

**The network:** SW1 has SVIs vlan10, vlan20, vlan30 and a static route to 10.9.0.0/24 via router R. SW2 is a plain VLAN switch.

## Run it

```bash
node engine/bin/openpacketrouter.mjs run examples/l3-switch/spec.json examples/l3-switch/actions.json --text
```

`--text` prints a readable report of what every device did. Without it you get JSON with the frames on each cable.

## Try it on a device console

Each device has a console. Open one with `node cli/bin/opr-cli.mjs examples/l3-switch/spec.json DEVICE`, or use the Studio. Type `?` at any point to see what is allowed.

On **SW1**:

```console
SW1> enable
SW1> show vlan brief
SW1> show ip route
```

- `enable`: Privileged mode.
- `show vlan brief`: One line per VLAN.
- `show ip route`: The SVI networks and the static route.

On **A**:

```console
A> ping 10.9.0.10
```

- `ping 10.9.0.10`: Across the L3 switch and out to the server network: works.

## What to expect

- Pings between VLANs 10 and 20 work with no external router; the switch itself routes them.
- Traffic for 10.9.0.0/24 goes via the static route to R. A traceroute from a host shows two hops: the switch's SVI, then R.

## Change something

Delete the static route in the spec: pings to 10.9.0.10 now fail.

More detail for the curious: [the lab's own README](../../examples/l3-switch/README.md).
