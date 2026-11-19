# DHCP, then across a router

PC1 starts with no address. The DHCP server on the same switch gives it 10.0.0.100 (the first free address in its range), tells it the router and DNS server, and PC1 can then reach WEB on a second network through R1.

```bash
node engine/bin/openpacketrouter.mjs run examples/dhcp-router/spec.json examples/dhcp-router/actions.json --text
```

**Look for:** the four DHCP steps (discover, offer, request, acknowledge), all broadcasts at first; then ARP for the router and the routed ping. The server's `router` option is what gives PC1 its default gateway.

**Note:** DHCP broadcasts do not cross a router, so here the server sits on PC1's side. Serving a remote LAN needs a relay; the engine does not model that yet.
