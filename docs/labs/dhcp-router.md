# DHCP on the same LAN, then a router

**What it shows:** A host with no address gets one automatically, then uses the router DHCP told it about.

**The network:** PC1 starts with no address. A DHCP server shares its switch; R1 joins it to the network where WEB lives.

## Run it

```bash
node engine/bin/openpacketrouter.mjs run examples/dhcp-router/spec.json examples/dhcp-router/actions.json --text
```

`--text` prints a readable report of what every device did. Without it you get JSON with the frames on each cable.

## Try it on a device console

Each device has a console. Open one with `node cli/bin/opr-cli.mjs examples/dhcp-router/spec.json DEVICE`, or use the Studio. Type `?` at any point to see what is allowed.

On **DHCP**:

```console
DHCP> show ip dhcp binding
```

- `show ip dhcp binding`: Addresses handed out. Empty until the lab has run (a fresh console starts before PC1 asks).

On **PC1**:

```console
PC1> show interface brief
```

- `show interface brief`: Shows the method `dhcp`.

## What to expect

- The four DHCP messages (discover, offer, request, ack) appear in the run output, first as broadcasts. PC1 gets 10.0.0.100 plus a gateway and DNS server.
- The routed ping to WEB works only because DHCP provided the default gateway.

## Change something

Shrink the pool's `range` to one address and add a second client: the second gets nothing.

More detail for the curious: [the lab's own README](../../examples/dhcp-router/README.md).
