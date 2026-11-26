// Run BGP steps on a spec; print the BGP state at each snapshot and every BGP message on every cable.
//   node tools/run_bgp.mjs spec.json steps.json
// steps: {"wait": s}; {"snapshot": label}; {"ping": [src, dst]}; {"linkDown": "node:iface"} / {"linkUp": "node:iface"}.
// Output: {"steps": [{t, snapshot, routers: {name: {neighbors, routes}}, packets} | {t, ping, result}],
//          "packets": [{t, cable: "A:if>B:if", src, dst, type, ...}]}
// validate/bgp/run_kernel_bgp.py reads this; keep it bare JSON.
import fs from "node:fs";
import {Network, ping} from "../src/index.js";

const ipNum = c => c.split("/")[0].split(".").reduce((a, o) => a * 256 + +o, 0);
const [specFile, stepsFile] = process.argv.slice(2);
const net = Network.fromSpec(JSON.parse(fs.readFileSync(specFile, "utf8")));
const steps = JSON.parse(fs.readFileSync(stepsFile, "utf8"));
const packets = [], out = [];
let clock = 0;
net.taps.add((n, i, f) => {
  const cable = `${n.name}:${i}>${n.ifaces[i].peer.node.name}:${n.ifaces[i].peer.name}`, t = net.time;
  const m = f.type === "ipv4" && f.ip.tcp && f.ip.tcp.data && f.ip.tcp.data.bgp;
  if (!m) return;
  const p = {t, cable, src: f.ip.src, dst: f.ip.dst, type: m.type};
  if (m.type === "open") Object.assign(p, {as: m.as, hold: m.hold, routerId: m.routerId});
  if (m.type === "update") Object.assign(p, {nlri: [...m.nlri].sort(), withdrawn: [...m.withdrawn].sort(), ...(m.attrs ? {asPath: m.attrs.asPath.join(" "), nextHop: m.attrs.nextHop, origin: m.attrs.origin} : {})});
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
    for (const n of net.nodes.values()) if (n.bgp) routers[n.name] = {neighbors: n.bgp.neighbors().map(x => ({ip: x.ip, remoteAs: x.remoteAs, up: x.state === "Established", routerId: x.state === "Established" ? x.routerId : null})),
      routes: n.bgp.describe(), fib: n.bgp.fib().map(r => ({network: r.cidr, gw: r.gw, iface: r.iface})).sort((a, b) => ipNum(a.network) - ipNum(b.network))};
    out.push({t: net.time, snapshot: s.snapshot, routers, packets: packets.length});
  }
}
process.stdout.write(JSON.stringify({steps: out, packets}, null, 1));
