import test from "node:test";
import assert from "node:assert/strict";
import {Network, ping, validateSpec} from "../src/index.js";
import {hashLayer2} from "../src/lacp.js";

const spec = (extra = {}, rate2) => ({version: 1, nodes: [
  {name: "S1", kind: "switch", channels: {Po1: {ports: ["p3", "p4", "p5"], ...extra}}},
  {name: "S2", kind: "switch", channels: {Po1: {ports: ["p3", "p4", "p5"], ...(rate2 ? {rate: rate2} : extra)}}},
  {name: "A", kind: "host", ifaces: {eth0: "10.0.0.1/24"}}, {name: "B", kind: "host", ifaces: {eth0: "10.0.0.2/24"}}],
  links: [["A:eth0", "S1:p1"], ["B:eth0", "S2:p1"], ["S1:p3", "S2:p3"], ["S1:p4", "S2:p4"], ["S1:p5", "S2:p5"]]});
const pdus = net => { const seen = []; net.taps.add((n, i, f) => { if (f.type === "lacpdu") seen.push({t: net.time, cable: `${n.name}:${i}`, a: f.lacpdu.actor.state, p: f.lacpdu.partner.state}); }); return seen; };
const members = (net, sw = "S1") => net.node(sw).channels.get("Po1").describe().members;

test("LACP handshake: 0xc5, 0x05, 0x0d, then 0x3d (collecting and distributing) on every member, like the kernel's bonding driver", () => {
  const net = Network.fromSpec(spec()); const seen = pdus(net); net.run(6);
  const p3 = seen.filter(x => x.cable === "S1:p3");
  assert.deepEqual(p3.map(x => x.a), [0xc5, 0x05, 0x0d, 0x3d]);
  assert.deepEqual(p3.map(x => x.p), [0x03, 0xc5, 0x05, 0x0d]);
  for (const m of [...members(net), ...members(net, "S2")]) { assert.equal(m.state, 0x3d); assert.equal(m.partner.state, 0x3d); assert.equal(m.aggregated, true); }
});

test("slow rate: a PDU every 30 s per member; a peer asking for fast gets one a second", () => {
  const net = Network.fromSpec(spec({}, "fast")); const seen = pdus(net); net.run(6);
  const mark = seen.length; net.run(16);
  const w = seen.slice(mark);
  assert.ok(w.filter(x => x.cable === "S1:p3").length >= 9, "S1 sends fast because S2 asked for it");
  assert.equal(w.filter(x => x.cable === "S2:p3").length, 0, "S2 sends slow because S1 did not ask");
  net.run(40); assert.ok(seen.some(x => x.cable === "S2:p3" && x.t > 25), "the slow side's periodic PDU comes about 30 s in");
});

test("transmit hash: dst MAC byte xor src MAC byte xor EtherType, modulo the members (values read from a kernel bond)", () => {
  const f = (dst, src, type) => ({dst: `02:00:00:00:00:${dst}`, src: `02:00:00:00:00:${src}`, type});
  assert.equal(hashLayer2(f("03", "01", "ipv4"), 3), 1);
  assert.equal(hashLayer2(f("03", "01", "arp"), 3), 0);
  assert.equal(hashLayer2({dst: "ff:ff:ff:ff:ff:ff", src: "02:00:00:00:00:04", type: "arp"}, 3), 0);
  assert.equal(hashLayer2({dst: "ff:ff:ff:ff:ff:ff", src: "02:00:00:00:00:01", type: "ipv4"}, 3), 1);
  assert.equal(hashLayer2(f("0a", "0a", "ipv4"), 3), 2);
});

test("a ping crosses the channel; the MAC table learns the far host on Po1; every frame uses one member", () => {
  const net = Network.fromSpec(spec()); net.run(6);
  const b = net.snapshot(); assert.equal(ping(net, "A", "10.0.0.2").ok, true); net.run(net.time + 1);
  const d = net.diff(b);
  for (const dir of ["S1", "S2"]) assert.ok(Object.keys(d).filter(k => new RegExp(`^${dir}:p[345]>`).test(k)).every(k => d[k] >= 1));
  assert.equal(net.node("S1").macTable().find(e => e.mac === net.node("B").ifaces.eth0.mac).port, "Po1");
  const crossing = Object.entries(d).filter(([k]) => /^S1:p[345]>S2/.test(k)).reduce((s, [, v]) => s + v, 0);
  assert.equal(crossing, 2, "ARP request (flooded) and echo request");
});

test("cutting a member: the rest carry on and the dead cable carries nothing; restoring it rejoins after the 2 s wait", () => {
  const net = Network.fromSpec(spec()); net.run(6);
  net.setLink("S1:p3", false); net.run(net.time + 1);
  assert.deepEqual(members(net).map(m => m.aggregated), [false, true, true]);
  const b = net.snapshot(); assert.equal(ping(net, "A", "10.0.0.2").ok, true); net.run(net.time + 1);
  assert.equal(Object.keys(net.diff(b)).some(k => k.includes("S1:p3>")), false);
  net.setLink("S1:p3", true); net.run(net.time + 1);
  assert.equal(members(net)[0].aggregated, false, "still negotiating");
  net.run(net.time + 5);
  assert.deepEqual(members(net).map(m => m.aggregated), [true, true, true]);
});

test("losing every member takes the channel down; bringing one back brings it up", () => {
  const net = Network.fromSpec(spec()); net.run(6);
  for (const p of ["p3", "p4", "p5"]) net.setLink(`S1:${p}`, false);
  net.run(net.time + 1);
  assert.equal(net.node("S1").ifaces.Po1.link, null);
  assert.equal(ping(net, "A", "10.0.0.2", {timeout: 1}).ok, false);
  net.setLink("S1:p4", true); net.run(net.time + 6);
  assert.equal(ping(net, "A", "10.0.0.2").ok, true);
});

test("spec validator: channels need cabled, unshared ports and no spanning tree", () => {
  const bad = f => { const s = spec(); f(s); return validateSpec(s).errors.map(e => e.message).join("\n"); };
  assert.match(bad(s => { s.nodes[0].channels.Po1.ports.push("p9"); }), /port p9 has no cable/);
  assert.match(bad(s => { s.nodes[0].channels.Po2 = {ports: ["p3"]}; }), /p3 is in two channels/);
  assert.match(bad(s => { s.nodes[0].channels.Po1.rate = "turbo"; }), /rate must be/);
  assert.match(bad(s => { s.nodes[0].stp = {}; }), /spanning tree over a port-channel/);
  assert.match(bad(s => { s.nodes[0].channels = {Po1: {}}; }), /needs "ports"/);
  assert.equal(validateSpec(spec()).errors.length, 0);
});
