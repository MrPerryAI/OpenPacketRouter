// Run MAC-aging steps on a spec: the same steps validate/aging/run_kernel_aging.py runs on Linux bridges.
//   node tools/run_aging.mjs spec.json steps.json
// steps: {"flush": true} forget every MAC table and ARP cache; {"wait": s}; {"ping": [src, dst], "settle": s};
//        {"table": [switch, ...]} record each switch's learned entries as {"host:iface": port}; with "fresh": true only
//        the unexpired entries of hosts (see the comment below);
//        {"gcReset": true} write every switch's aging time again (the kernel then runs its MAC collector at once);
//        {"link": {"end": "SW:port", "up": bool}}; {"tc": [switch, ...]} record the spanning tree's
//        topology-change flag, whether a TCN is unacknowledged, and the MAC aging time in force.
import fs from "node:fs";
import {Network, ping} from "../src/index.js";

const [specFile, stepsFile] = process.argv.slice(2);
const net = Network.fromSpec(JSON.parse(fs.readFileSync(specFile, "utf8")));
const out = [];
const owner = new Map();   // MAC -> "node:iface"
for (const n of net.nodes.values()) for (const i of Object.values(n.ifaces)) owner.set(i.mac, `${n.name}:${i.name}`);
for (const s of JSON.parse(fs.readFileSync(stepsFile, "utf8"))) {
  if (s.flush) net.flushCaches();
  else if (s.gcReset) { net._start(); for (const n of net.nodes.values()) if (n.kind === "switch") n.setAgingTime(n.agingTime); }
  else if (s.link) net.setLink(s.link.end, !!s.link.up);
  else if (s.tc) {
    const bridges = {};
    for (const name of s.tc) { const n = net.node(name); bridges[name] = {topologyChange: +n.stp.tc, topologyChangeDetected: +n.stp.tcd, agingTime: n.agingOverride ?? n.agingTime}; }
    out.push({tc: s.tc, bridges});
  } else if (s.wait !== undefined) net.run(net.time + s.wait);
  else if (s.ping) {
    const before = net.snapshot();
    const r = ping(net, s.ping[0], s.ping[1], {timeout: 2});
    net.settle(s.settle ?? 1);
    out.push({ping: s.ping, ok: r.ok, ...(s.frames === false ? {} : {frames: net.diff(before)})});   // "frames": false where BPDUs share the cables
  } else if (s.table) {
    const tables = {};
    // "fresh": only entries that have not expired, and only hosts' MACs: whether an expired entry is still listed depends on
    // when the kernel's collector last ran, and switches' own port MACs are learned from BPDUs, whose timing varies.
    for (const name of s.table) tables[name] = Object.fromEntries(net.node(name).macTable().filter(e => !s.fresh || (!e.stale && net.nodes.get(owner.get(e.mac).split(":")[0]).kind !== "switch")).map(e => [`${e.vlan}|${owner.get(e.mac)}`, e.port]));
    out.push({table: s.table, tables});
  }
}
process.stdout.write(JSON.stringify(out, null, 1));
