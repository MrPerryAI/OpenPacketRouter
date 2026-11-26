// Run RSTP steps on a spec: the same steps validate/rstp/run_kernel_rstp.py runs on Linux bridges under mstpd.
//   node tools/run_rstp.mjs spec.json steps.json
// Every switch of the spec runs rapid spanning tree. Steps:
//   {"wait": s}; {"link": {"end": "SW:port", "up": bool}} (both ends follow, as a cable does);
//   {"stp": [switch, ...]} each bridge's root, root port, path cost and every port's role, state and whether it is an edge port;
//   {"bpdus": "mark"} start a new window; {"bpdus": true} the kinds of BPDU each cable direction sent since the last mark
//   (rstp-XX is an RSTP BPDU with flags byte XX; see validate/rstp/sniff_bpdu.py).
import fs from "node:fs";
import {Network} from "../src/index.js";

const [specFile, stepsFile] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specFile, "utf8"));
for (const n of spec.nodes) if (n.kind === "switch") n.stp = {...n.stp, mode: "rstp"};
const net = Network.fromSpec(spec);
const sent = new Map(); let mark = new Map();
const kindOf = b => b.tcn ? "tcn" : b.version >= 2 ? `rstp-${b.flags.toString(16).padStart(2, "0")}` : "config" + (b.tc ? "+tc" : "") + (b.tca ? "+tca" : "");
net.taps.add((node, ifname, frame) => {
  if (frame.type !== "bpdu") return;
  const p = node.ifaces[ifname].peer, k = `${node.name}:${ifname}>${p.node.name}:${p.name}`;
  if (!sent.has(k)) sent.set(k, []); sent.get(k).push(kindOf(frame.bpdu));
});
const window = () => { const w = {}; for (const [k, v] of sent) { w[k] = v.slice(mark.get(k) || 0); mark.set(k, v.length); } return w; };
const out = [];
for (const s of JSON.parse(fs.readFileSync(stepsFile, "utf8"))) {
  if (s.wait !== undefined) net.run(net.time + s.wait);
  else if (s.link) net.setLink(s.link.end, !!s.link.up);
  else if (s.bpdus === "mark") window();
  else if (s.bpdus) { const kinds = {}; for (const [k, v] of Object.entries(window())) if (v.length) kinds[k] = [...new Set(v)].sort(); out.push({bpdus: true, kinds}); }
  else if (s.stp) {
    const bridges = {};
    for (const name of s.stp) {
      const d = net.node(name).stp.describe();
      bridges[name] = {root: d.root, rootPort: d.rootPort, rootCost: d.rootCost, ports: Object.fromEntries(Object.entries(d.ports).map(([p, v]) => [p, {role: v.role, state: v.state, edge: !!v.edge}]))};
    }
    out.push({stp: s.stp, bridges});
  }
}
process.stdout.write(JSON.stringify(out, null, 1));
