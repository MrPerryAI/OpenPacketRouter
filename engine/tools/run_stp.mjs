// Run spanning-tree steps on a spec and print the port roles after each snapshot.
//   node tools/run_stp.mjs spec.json steps.json
// steps: {"wait": s} run s simulated seconds; {"snapshot": label}; {"ping": [src, dst]};
//        {"linkDown": "SW:port"} / {"linkUp": "SW:port"}.
import fs from "node:fs";
import {Network, ping} from "../src/index.js";

const [specFile, stepsFile] = process.argv.slice(2);
const net = Network.fromSpec(JSON.parse(fs.readFileSync(specFile, "utf8")));
const steps = JSON.parse(fs.readFileSync(stepsFile, "utf8"));
const out = [];
const strip = s => s;
for (const s of steps) {
  if (s.wait !== undefined) net.run(net.time + s.wait);
  else if (s.linkDown) net.setLink(s.linkDown, false);
  else if (s.linkUp) net.setLink(s.linkUp, true);
  else if (s.ping) out.push({ping: s.ping, ok: ping(net, s.ping[0], s.ping[1], {timeout: 2}).ok});
  else if (s.snapshot) {
    const bridges = {};
    for (const n of net.nodes.values()) if (n.stp) {
      const d = n.stp.describe();
      bridges[n.name] = {root: d.root, bridgeId: d.bridgeId, rootCost: d.rootCost, ports: Object.fromEntries(Object.entries(d.ports).map(([p, v]) =>
        [p, {role: v.role, state: v.state, designatedCost: v.designatedCost, designatedBridge: v.designatedBridge, designatedPort: v.designatedPort}]))};
    }
    out.push({snapshot: s.snapshot, bridges});
  }
}
process.stdout.write(JSON.stringify(out, null, 1));
