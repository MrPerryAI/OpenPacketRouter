# Student guides for the example labs

Each guide says what the lab shows, the commands to try and what you should see. The lab files live in [examples/](../../examples/); run any lab from the repository root. Spec keys are in [spec-format.md](../spec-format.md), console commands in [cli-reference.md](../cli-reference.md).

| Guide | In one line |
|---|---|
| [Switch ring with no spanning tree](loop-no-stp.md) | What happens when switches are cabled in a circle and nothing stops frames going round it. |
| [Switch ring with spanning tree](loop-with-stp.md) | How spanning tree breaks a loop: it picks a root switch and blocks exactly enough ports to leave a tree. |
| [Spanning tree topology change](stp-topology-change.md) | What a switch does when a cable fails: it announces the change and shortens how long it remembers addresses. |
| [MAC address aging](mac-aging.md) | A switch forgets a host that has been silent for the aging time, and floods traffic to it until it learns again. |
| [Two VLANs across a trunk](vlans.md) | How VLANs split one switch network into separate broadcast domains, and how one trunk cable carries several of them. |
| [LACP port-channel](lacp-channel.md) | Several cables between two switches behaving as one fat link, negotiated with LACP. |
| [Router on a stick](intervlan-roas.md) | One router, one cable, several VLANs: the router has a subinterface per VLAN and routes between them. |
| [Layer 3 switch](l3-switch.md) | A switch that routes: virtual interfaces (SVIs) act as the gateways for each VLAN. |
| [Two LANs, a router and DNS](routed-lan-dns.md) | The basics of routing: ARP for the gateway, forwarding between subnets, traceroute, and DNS. |
| [DHCP on the same LAN, then a router](dhcp-router.md) | A host with no address gets one automatically, then uses the router DHCP told it about. |
| [DHCP through a relay](dhcp-relay.md) | Why a router does not forward DHCP broadcasts, and how a relay hands them to a server on another network. |
| [A 1 Mbit bottleneck](bottleneck.md) | What happens when a fast sender meets a slow link with a small queue: frames get dropped. |
| [TCP across a router](tcp.md) | The TCP handshake, an echo, a clean close, and what a refused port and a silent host look like. |
| [RIP on a chain of routers](rip-chain.md) | How routers learn routes from each other with RIPv2, and how a cut cable poisons them. |
| [Count to infinity](count-to-infinity.md) | A classic routing failure: bad news and stale news chase each other around a loop of routers. |
| [Access lists on a router](acl-lab.md) | Filtering traffic with ordered permit/deny rules on an interface, and what a denied sender is told. |
| [NAT on a router](nat-lab.md) | Private addresses sharing one public address (overload), a fixed 1:1 mapping, and a port forward. |
