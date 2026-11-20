// Run OSPF steps on a spec; print the OSPF state at each snapshot and every OSPF packet on every cable.
//   node tools/run_ospf.mjs spec.json steps.json
// steps: {"wait": s} run s simulated seconds; {"snapshot": label}; {"ping": [src, dst]};
//        {"linkDown": "node:iface"} / {"linkUp": "node:iface"} (carrier lost / back on both ends).
// Output: {"steps": [{t, snapshot, routers: {name: {neighbors, interfaces, routes, database}}, packets} | {t, ping, result}],
//          "packets": [{t, cable: "A:if>B:if", src, dst, ttl, type, routerId, ...hello fields}]}
// validate/ospf/run_kernel_ospf.py reads this; keep it bare JSON.
import fs from "node:fs";
import {Network, ping} from "../src/index.js";

const [specFile, stepsFile] = process.argv.slice(2);
const net = Network.fromSpec(JSON.parse(fs.readFileSync(specFile, "utf8")));
const steps = JSON.parse(fs.readFileSync(stepsFile, "utf8"));
const packets = [], out = [];
let clock = 0;
net.taps.add((n, i, f) => {
  const cable = `${n.name}:${i}>${n.ifaces[i].peer.node.name}:${n.ifaces[i].peer.name}`, t = net.time;
  const o = f.type === "ipv4" && f.ip.ospf;
  if (!o) return;
  const p = {t, cable, src: f.ip.src, dst: f.ip.dst, ttl: f.ip.ttl, type: o.type, routerId: o.routerId};
  if (o.type === "hello") Object.assign(p, {mask: o.mask, helloInterval: o.helloInterval, deadInterval: o.deadInterval, options: o.options,
    priority: o.priority, dr: o.dr, bdr: o.bdr, neighbors: [...o.neighbors].sort()});
  packets.push(p);
});
for (const s of steps) {
  if (s.wait !== undefined) { clock += s.wait; net.run(clock); if (net.time < clock) net.time = clock; }
  else if (s.linkDown) net.setLink(s.linkDown, false);
  else if (s.linkUp) net.setLink(s.linkUp, true);
  else if (s.ping) {
    net.flushCaches();
    const r = ping(net, s.ping[0], s.ping[1], {timeout: 2});
    clock = Math.max(clock, net.time);
    out.push({t: net.time, ping: s.ping, result: r});
  } else if (s.snapshot) {
    const routers = {};
    for (const n of net.nodes.values()) if (n.ospf) routers[n.name] = {neighbors: n.ospf.neighbors(), interfaces: n.ospf.interfaces(), routes: n.ospf.describe(), database: n.ospf.database()};
    out.push({t: net.time, snapshot: s.snapshot, routers, packets: packets.length});
  }
}
process.stdout.write(JSON.stringify({steps: out, packets}, null, 1));
