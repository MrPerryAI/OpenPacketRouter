# DHCP through a relay

**What it shows:** Why a router does not forward DHCP broadcasts, and how a relay hands them to a server on another network.

**The network:** The only DHCP server is on 10.0.0.0/24. PCs are on 10.1.0.0/24, behind R1, which relays.

## Run it

```bash
node engine/bin/openpacketrouter.mjs run examples/dhcp-relay/spec.json examples/dhcp-relay/actions.json --text
```

`--text` prints a readable report of what every device did. Without it you get JSON with the frames on each cable.

## Try it on a device console

Each device has a console. Open one with `node cli/bin/opr-cli.mjs examples/dhcp-relay/spec.json DEVICE`, or use the Studio. Type `?` at any point to see what is allowed.

On **R1**:

```console
R1> enable
R1> show running-config
```

- `enable`: Privileged mode.
- `show running-config`: Look for the helper address on the PC-side interface.

On **DHCP**:

```console
DHCP> show ip dhcp binding
```

- `show ip dhcp binding`: What the server has handed out.

## What to expect

- The PC's broadcast stops at R1. R1 forwards it as a unicast to the server, then passes the reply back to the PC. PC1 gets 10.1.0.100 and PC2 gets 10.1.0.101 from the server's second pool.
- Without the relay setting, the PCs never get an address.

## Change something

Remove `dhcpRelay` from R1 in the spec and run again.

More detail for the curious: [the lab's own README](../../examples/dhcp-relay/README.md).
