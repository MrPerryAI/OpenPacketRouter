// Run VRRP steps on a spec; print every VRRP group's state at each snapshot and every advertisement on every cable.
//   node tools/run_vrrp.mjs spec.json steps.json
// steps: {"wait": s}; {"linkDown": "node:iface"} / {"linkUp": "node:iface"}; {"snapshot": label, "ping"?: [src, dstIp]}.
// Output: {"steps": [{t, snapshot, states: {"R1": "master"}, ping?: bool, frames}], "frames": [{t, cable, src, dst, vrid, priority, interval, ttl}]}
// validate/vrrp/run_kernel_vrrp.py reads this; keep it bare JSON.
import fs from "node:fs";
import {Network, ping} from "../src/index.js";

const [specFile, stepsFile] = process.argv.slice(2);
const net = Network.fromSpec(JSON.parse(fs.readFileSync(specFile, "utf8")));
const steps = JSON.parse(fs.readFileSync(stepsFile, "utf8"));
const frames = [], out = [];
net.taps.add((n, i, f) => {
  if (f.type !== "ipv4" || f.ip.proto !== "vrrp") return;
  const v = f.ip.vrrp;
  frames.push({t: net.time, cable: `${n.name}:${i}>${n.ifaces[i].peer.node.name}:${n.ifaces[i].peer.name}`, src: f.ip.src, dst: f.dst, vrid: v.vrid, priority: v.priority, interval: v.interval, ttl: f.ip.ttl});
});
let clock = 0;
for (const s of steps) {
  if (s.wait !== undefined) { clock += s.wait; net.run(clock); if (net.time < clock) net.time = clock; }
  else if (s.linkDown) net.setLink(s.linkDown, false);
  else if (s.linkUp) net.setLink(s.linkUp, true);
  else if (s.snapshot) {
    const states = {};
    for (const n of net.nodes.values()) if (n.vrrp) states[n.name] = n.vrrp.describe()[0].state === "master" ? "master" : "not master";
    const e = {t: net.time, snapshot: s.snapshot, states, frames: frames.length};
    if (s.ping) e.ping = ping(net, s.ping[0], s.ping[1]).ok;
    out.push(e);
  }
}
console.log(JSON.stringify({steps: out, frames}));
