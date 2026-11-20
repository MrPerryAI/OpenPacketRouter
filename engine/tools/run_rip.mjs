// Run RIP steps on a spec; print the RIP tables at each snapshot and every RIP packet on every cable.
//   node tools/run_rip.mjs spec.json steps.json
// steps: {"wait": s} run s simulated seconds; {"snapshot": label}; {"ping": [src, dst]};
//        {"linkDown": "node:iface"} / {"linkUp": "node:iface"} (carrier lost / back on both ends).
// Output: {"steps": [{t, snapshot, tables: {router: [{network, nextHop, metric, type, iface}]}} | {t, ping, result}],
//          "packets": [{t, cable: "A:if>B:if", src, dst, ttl, sport, dport, command, version, entries}]}
// validate/rip/run_kernel_rip.py reads this; keep it bare JSON.
import fs from "node:fs";
import {Network, ping} from "../src/index.js";

const [specFile, stepsFile] = process.argv.slice(2);
const net = Network.fromSpec(JSON.parse(fs.readFileSync(specFile, "utf8")));
const steps = JSON.parse(fs.readFileSync(stepsFile, "utf8"));
const packets = [], out = [];
let clock = 0;   // absolute: net.run(until) stops at the last event before `until` while protocol timers are pending
net.taps.add((n, i, f) => { const cable = `${n.name}:${i}>${n.ifaces[i].peer.node.name}:${n.ifaces[i].peer.name}`, t = net.time;
  const rip = f.type === "ipv4" && f.ip.proto === "udp" && f.ip.udp.payload && f.ip.udp.payload.rip;
  if (rip) packets.push({t, cable, src: f.ip.src, dst: f.ip.dst, ttl: f.ip.ttl, sport: f.ip.udp.sport, dport: f.ip.udp.dport,
    command: rip.command, version: rip.version, entries: rip.entries.map(e => ({net: e.net, mask: e.mask, nextHop: e.nextHop, metric: e.metric, tag: e.tag}))});
});
for (const s of steps) {
  if (s.wait !== undefined) { clock += s.wait; net.run(clock); if (net.time < clock) net.time = clock; }   // nothing is left before `clock`
  else if (s.linkDown) net.setLink(s.linkDown, false);
  else if (s.linkUp) net.setLink(s.linkUp, true);
  else if (s.ping) {
    net.flushCaches();
    const r = ping(net, s.ping[0], s.ping[1], {timeout: 2});
    clock = Math.max(clock, net.time);
    out.push({t: net.time, ping: s.ping, result: r});
  } else if (s.snapshot) {
    const tables = {};
    for (const n of net.nodes.values()) if (n.rip) tables[n.name] = n.rip.describe();
    out.push({t: net.time, snapshot: s.snapshot, tables, packets: packets.length});   // packets sent before this snapshot
  }
}
process.stdout.write(JSON.stringify({steps: out, packets}, null, 1));
