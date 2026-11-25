// Run port-security steps on a spec: the same steps validate/portsec/run_kernel_portsec.py runs on a Linux bridge with nftables.
//   node tools/run_portsec.mjs spec.json steps.json
// steps: {"flush": true}; {"ping": [src, dst]} (records ok and the frames per cable direction);
//        {"portsec": "SW"} the secured addresses ("node:iface") and the violation count of every limited port.
import fs from "node:fs";
import {Network, ping} from "../src/index.js";

const [specFile, stepsFile] = process.argv.slice(2);
const net = Network.fromSpec(JSON.parse(fs.readFileSync(specFile, "utf8")));
const owner = new Map();
for (const n of net.nodes.values()) for (const i of Object.values(n.ifaces)) owner.set(i.mac, `${n.name}:${i.name}`);
const out = [];
for (const s of JSON.parse(fs.readFileSync(stepsFile, "utf8"))) {
  if (s.flush) net.flushCaches();
  else if (s.ping) {
    const before = net.snapshot();
    const r = ping(net, s.ping[0], s.ping[1], {timeout: 2});
    net.run(net.time + 1);
    out.push({ping: s.ping, ok: r.ok, frames: net.diff(before)});
  } else if (s.portsec) {
    const ports = {};
    for (const p of net.node(s.portsec).portSecurity()) ports[p.port] = {secured: p.secured.map(m => owner.get(m)).sort(), violations: p.violations};
    out.push({portsec: s.portsec, ports});
  }
}
process.stdout.write(JSON.stringify(out, null, 1));
