# DHCP through a relay

In a real school there is usually one DHCP server, not one per network. PC1 and PC2 are on the 10.1.0.0/24 network; the DHCP server is on 10.0.0.0/24 behind router R1. A DHCP request is a broadcast, and a router never forwards broadcasts, so R1 is told to relay (`dhcpRelay` in the spec): it picks up the broadcast, writes its own address on the 10.1.0.0 side into it (the `giaddr` field), and sends it to the server as an ordinary packet. The server uses that address to choose the pool for the PC's network.

```bash
node engine/bin/openpacketrouter.mjs run examples/dhcp-relay/spec.json examples/dhcp-relay/actions.json --text
```

**Look for:** the PC's broadcast stops at R1; the server's offer comes back to R1, which hands it to the PC with a normal unicast frame. PC1 gets 10.1.0.100 and PC2 gets 10.1.0.101 (from the `pools` entry, not the server's own range), and the last ping shows PC1 can now reach the server using the router the server handed out.

**Compare:** [dhcp-router](../dhcp-router/) puts the server on the PC's own network, so no relay is needed. This engine's relay is modeled on, and checked frame for frame against, dnsmasq's relay mode (see validate/dhcp/results.md).
