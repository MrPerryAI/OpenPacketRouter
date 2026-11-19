# Example labs

Ready-to-run networks for the OpenPacketRouter engine. Each folder has a `spec.json` (the network), an
`actions.json` (what to do on it) and a short README saying what to look for. No install needed beyond Node 18+.

From the repository root:

```bash
node engine/bin/openpacketrouter.mjs run examples/vlans/spec.json examples/vlans/actions.json --text
```

`--text` prints a readable report with every switch and router decision. Leave it off for JSON (frame counts per cable);
add `--compact` for one line. Spec keys are in [docs/spec-format.md](../docs/spec-format.md).

| Lab | Shows | Try changing |
|---|---|---|
| [loop-no-stp](loop-no-stp/) | A cabling loop with no spanning tree: one ARP broadcast becomes a storm | Remove one cable and rerun |
| [loop-with-stp](loop-with-stp/) | The same loop with spanning tree: one port blocks, the ping works | Change a switch's `priority` to move the root |
| [vlans](vlans/) | VLANs and a trunk: same VLAN talks across switches, different VLANs cannot | Move a host to another `access` VLAN |
| [dhcp-router](dhcp-router/) | A host with no address gets one by DHCP, then reaches a server through a router | Shrink the `range` |
| [dhcp-relay](dhcp-relay/) | One DHCP server for a network behind a router: the router relays the request | Remove the `dhcpRelay` line: PC1 never gets an address |
| [bottleneck](bottleneck/) | A 1 Mbit link with a small queue: a long burst is dropped | Raise `rate` or `limit` |
| [tcp](tcp/) | TCP handshake, echo, close; a refused port; a SYN with no answer | Give BROKEN a gateway |
| [routed-lan-dns](routed-lan-dns/) | Ping, traceroute and DNS across a router, plus a ping to an address nobody has | Remove `gw` from PC1 |

`index.json` lists the labs for tools (the browser studio reads it); add new labs there too.

Every lab is run by `engine/test/examples.test.js`, so the READMEs stay true.
