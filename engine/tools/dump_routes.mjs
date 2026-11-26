// Print every host's and router's IPv4 routing table (connected and static routes) as the engine holds it.
//   node tools/dump_routes.mjs spec.json
// Output: {"R1": [{"dst": "10.0.0.0/24", "via": null, "dev": "eth0"}, {"dst": "default", "via": "10.0.0.254", "dev": "eth0"}]}, rows sorted.
// A static route whose next hop is on no connected subnet is left out: Linux refuses to install it too.
// validate/frr-static/run_frr_static.py compares this with the kernel's table after FRR's staticd installed the routes.
import fs from "node:fs";
import {Network} from "../src/index.js";
import {intToIp, inSubnet} from "../src/addr.js";

const net = Network.fromSpec(JSON.parse(fs.readFileSync(process.argv[2], "utf8")));
const text = (n, prefix) => prefix === 0 ? "default" : prefix === 32 ? intToIp(n) : `${intToIp(n)}/${prefix}`;
const out = {};
for (const [name, node] of net.nodes) {
  if (!node.routes || !node.ifaces) continue;
  const ifs = Object.values(node.ifaces).filter(i => i.ip);
  const rows = ifs.map(i => ({dst: text(i.net, i.prefix), via: null, dev: i.name}));
  for (const r of node.routes) {
    const o = ifs.find(i => inSubnet(r.via, i.net, i.mask));
    if (o) rows.push({dst: text(r.net, r.prefix), via: r.via, dev: o.name});
  }
  out[name] = rows.sort((a, b) => (a.dst < b.dst ? -1 : a.dst > b.dst ? 1 : 0) || String(a.via).localeCompare(String(b.via)));
}
console.log(JSON.stringify(out));
