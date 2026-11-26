// Run MAC-aging steps on a spec: the same steps validate/aging/run_kernel_aging.py runs on Linux bridges.
//   node tools/run_aging.mjs spec.json steps.json
// steps: {"flush": true} forget every MAC table and ARP cache; {"wait": s}; {"ping": [src, dst], "settle": s};
//        {"table": [switch, ...]} record each switch's learned entries as {"host:iface": port}; with "fresh": true only
//        the unexpired entries of hosts (see the comment below);
//        {"gcReset": true} write every switch's aging time again (the kernel then runs its MAC collector at once);
//        {"link": {"end": "SW:port", "up": bool}}; {"tc": [switch, ...]} record the spanning tree's
//        {"lacp": [switch, ...]} each channel member's carrier and LACP state bytes;
//        {"bpdus": true} the kinds (or "mark": start a new window, report nothing) of BPDU each cable direction carried since the last one; a ping's "frames": "data" leaves STP frames out;
//        topology-change flag, whether a TCN is unacknowledged, and the MAC aging time in force.
import fs from "node:fs";
import {Network, ping} from "../src/index.js";

const args = process.argv.slice(2), macsOnly = args[0] === "--macs";
const [specFile, stepsFile] = macsOnly ? args.slice(1) : args;
const net = Network.fromSpec(JSON.parse(fs.readFileSync(specFile, "utf8")));
if (process.env.OPR_JIFFY_HOLDS) net.jiffyHolds = +process.env.OPR_JIFFY_HOLDS;   // model Linux's round_jiffies on the STP hold timer (engine/src/stp.js, _holdTime); the validator aligns the kernel to whole seconds
const out = [];
const owner = new Map();   // MAC -> "node:iface"
for (const n of net.nodes.values()) for (const i of Object.values(n.ifaces)) if (!i.channel) owner.set(i.mac, `${n.name}:${i.name}`);   // a channel's members share one MAC; the channel is not a cable
if (macsOnly) {   // the engine's MAC for every cabled interface, so the kernel side can use the same addresses (LACP hashes on them)
  const m = {}; for (const n of net.nodes.values()) for (const i of Object.values(n.ifaces)) if (!i.channel && i.link) m[`${n.name}:${i.name}`] = i.mac;
  console.log(JSON.stringify(m)); process.exit(0);
}
// Per-cable record of what each interface sends, like validate/aging/cable.py on the kernel side: "data" or a BPDU kind.
const sent = new Map(), marks = {ping: new Map(), bpdus: new Map()};
const kindOf = f => f.type === "lacpdu" ? `lacp-${f.lacpdu.actor.state}-${f.lacpdu.partner.state}` : f.type !== "bpdu" ? "data" : f.bpdu.tcn ? "tcn" : "config" + (f.bpdu.tc ? "+tc" : "") + (f.bpdu.tca ? "+tca" : "");
net.taps.add((node, ifname, frame) => { const p = node.ifaces[ifname].peer, k = `${node.name}:${ifname}>${p.node.name}:${p.name}`; if (!sent.has(k)) sent.set(k, []); sent.get(k).push(kindOf(frame)); });
const window = who => { const w = {}; for (const [k, v] of sent) { w[k] = v.slice(marks[who].get(k) || 0); marks[who].set(k, v.length); } return w; };
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
    const before = net.snapshot(); window("ping");
    const r = ping(net, s.ping[0], s.ping[1], {timeout: 2});
    net.run(net.time + (s.settle ?? 1));
    let frames;   // "frames": "data" counts only non-STP frames (BPDUs share the cables); false compares none
    if (s.frames === "data") { frames = {}; for (const [k, v] of Object.entries(window("ping"))) if (v.includes("data")) frames[k] = v.filter(x => x === "data").length; }
    else frames = net.diff(before);
    out.push({ping: s.ping, ok: r.ok, ...(s.frames === false ? {} : {frames})});
  } else if (s.bpdus === "mark") window("bpdus");
  else if (s.bpdus) {
    const kinds = {};
    for (const [k, v] of Object.entries(window("bpdus"))) { const u = [...new Set(v)].filter(x => x !== "data").sort(); if (u.length) kinds[k] = u; }
    out.push({bpdus: true, kinds});
  } else if (s.lacp) {   // every member's up flag and LACP state bytes (actor, partner); a member without carrier shows null states
    const channels = {};
    for (const sw of s.lacp) { channels[sw] = {}; for (const [cn, ch] of net.node(sw).channels) channels[sw][cn] = Object.fromEntries(ch.members.map(m => [m.name, {up: m.up, state: m.up ? m.actor : null, partnerState: m.up ? m.partner.state : null}])); }
    out.push({lacp: s.lacp, channels});
  } else if (s.table) {
    const tables = {};
    // "fresh": only entries that have not expired, and only hosts' MACs: whether an expired entry is still listed depends on
    // when the kernel's collector last ran, and switches' own port MACs are learned from BPDUs, whose timing varies.
    for (const name of s.table) tables[name] = Object.fromEntries(net.node(name).macTable().filter(e => !s.fresh || (!e.stale && net.nodes.get(owner.get(e.mac).split(":")[0]).kind !== "switch")).map(e => [`${e.vlan}|${owner.get(e.mac)}`, e.port]));
    out.push({table: s.table, tables});
  }
}
process.stdout.write(JSON.stringify(out, null, 1));
