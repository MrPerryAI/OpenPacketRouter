// Run LLDP steps on a spec; print every node's neighbor table at each snapshot and every LLDPDU on every cable.
//   node tools/run_lldp.mjs spec.json steps.json
// steps: {"wait": s} run s simulated seconds; {"snapshot": label}; {"linkDown": "node:iface"} / {"linkUp": "node:iface"}.
// Output: {"macs": {mac: "node:iface"}, "steps": [{t, snapshot, nodes: {name: [neighbor...]}, frames}], "frames": [{t, cable, tlvs}]}
// validate/lldp/run_kernel_lldp.py reads this; keep it bare JSON.
import fs from "node:fs";
import {Network} from "../src/index.js";

const [specFile, stepsFile] = process.argv.slice(2);
const net = Network.fromSpec(JSON.parse(fs.readFileSync(specFile, "utf8")));
const steps = JSON.parse(fs.readFileSync(stepsFile, "utf8"));
const frames = [], out = [], macs = {};
for (const n of net.nodes.values()) for (const i of Object.values(n.ifaces)) if (i.mac && !i.parent) macs[i.mac] = `${n.name}:${i.name}`;
net.taps.add((n, i, f) => {
  if (f.type !== "lldp") return;
  const l = f.lldp;
  frames.push({t: net.time, cable: `${n.name}:${i}>${n.ifaces[i].peer.node.name}:${n.ifaces[i].peer.name}`, src: f.src, dst: f.dst,
    tlvs: {chassisId: l.chassisId, portId: l.portId, ttl: l.ttl, portDescr: l.portDescr, sysName: l.sysName, sysDescr: l.sysDescr, caps: l.caps}});
});
let clock = 0;
for (const s of steps) {
  if (s.wait !== undefined) { clock += s.wait; net.run(clock); if (net.time < clock) net.time = clock; }
  else if (s.linkDown) net.setLink(s.linkDown, false);
  else if (s.linkUp) net.setLink(s.linkUp, true);
  else if (s.snapshot) {
    const nodes = {};
    for (const n of net.nodes.values()) if (n.lldp) nodes[n.name] = n.lldp.neighbors();
    out.push({t: net.time, snapshot: s.snapshot, nodes, frames: frames.length});
  }
}
console.log(JSON.stringify({macs, steps: out, frames}));
