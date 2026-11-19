// The labs in examples/ (each a folder with spec.json and actions.json). tests/studio/smoke.mjs fails when a
// folder is added there and not here, so the dropdown stays complete.
export const EXAMPLES = [
  {id: "routed-lan-dns", title: "Two LANs and a router: ping, traceroute, DNS"},
  {id: "loop-no-stp", title: "Switch triangle, no spanning tree (storm)"},
  {id: "loop-with-stp", title: "Switch triangle, with spanning tree"},
  {id: "vlans", title: "Two VLANs across a trunk"},
  {id: "dhcp-router", title: "DHCP, then a router"},
  {id: "bottleneck", title: "A 1 Mbit bottleneck"},
  {id: "tcp", title: "TCP across a router"},
];
