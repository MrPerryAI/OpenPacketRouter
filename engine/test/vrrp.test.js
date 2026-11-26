import test from "node:test";
import assert from "node:assert/strict";
import {Network, ping, validateSpec} from "../src/index.js";

// H1 — S1 — {R1 (priority 200), R2 (priority 100)}, shared address 10.0.0.254, one server behind each router's other side.
const spec = (over = {}) => ({
  version: 1,
  nodes: [
    {name: "H1", kind: "host", ifaces: {eth0: "10.0.0.10/24"}, gw: "10.0.0.254"},
    {name: "S1", kind: "switch"},
    {name: "R1", kind: "router", ifaces: {eth0: "10.0.0.1/24", eth1: "10.1.0.1/24"}, vrrp: [{iface: "eth0", vrid: 1, ip: "10.0.0.254", priority: 200}]},
    {name: "R2", kind: "router", ifaces: {eth0: "10.0.0.2/24", eth1: "10.1.0.2/24"}, vrrp: [{iface: "eth0", vrid: 1, ip: "10.0.0.254", priority: 100, ...over}]},
    {name: "SRV", kind: "server", ifaces: {eth0: "10.1.0.10/24"}, gw: "10.1.0.1"},
    {name: "S2", kind: "switch"},
  ],
  links: [["H1:eth0", "S1:p1"], ["R1:eth0", "S1:p2"], ["R2:eth0", "S1:p3"], ["R1:eth1", "S2:p1"], ["R2:eth1", "S2:p2"], ["SRV:eth0", "S2:p3"]],
});
const build = (over, t = 10) => { const net = Network.fromSpec(spec(over)); net.run(t); if (net.time < t) net.time = t; return net; };
const st = (net, r) => net.node(r).vrrp.describe()[0].state;
const at = (net, t) => { net.run(t); if (net.time < t) net.time = t; };

test("the spec check accepts vrrp and catches bad groups", () => {
  assert.ok(validateSpec(spec()).ok);
  const s = spec(); s.nodes[2].vrrp = [{iface: "eth9", vrid: 0, ip: "10.9.9", priority: 300, interval: 0, preempt: "yes", extra: 1}, {iface: "eth0", vrid: 1, ip: "10.0.0.1", priority: 100}];
  const paths = validateSpec(s).errors.map(e => e.path);
  for (const p of ["iface", "vrid", "ip", "priority", "interval", "preempt", "extra"]) assert.ok(paths.includes(`$.nodes[2].vrrp[0].${p}`), p);
  assert.ok(paths.includes("$.nodes[2].vrrp[1].ip"));
});

test("the higher priority becomes master, the other stays backup", () => {
  const net = build();
  assert.equal(st(net, "R1"), "master"); assert.equal(st(net, "R2"), "backup");
  assert.equal(net.node("R2").vrrp.describe()[0].masterIp, "10.0.0.1");
});

test("the master answers ping and ARP for the virtual address and hosts reach the server through it", () => {
  const net = build();
  assert.ok(ping(net, "H1", "10.0.0.254").ok);
  assert.equal(net.node("H1").arp.get("10.0.0.254").mac, net.node("R1").ifaces.eth0.mac);
  assert.ok(ping(net, "H1", "10.1.0.10").ok);
});

test("when the master loses carrier the backup takes over after about three intervals and the virtual address answers again", () => {
  const net = build();
  net.setLink("R1:eth0", false); at(net, net.time + 5);
  assert.equal(st(net, "R1"), "fault"); assert.equal(st(net, "R2"), "master");
  assert.ok(ping(net, "H1", "10.0.0.254").ok);
  assert.equal(net.node("H1").arp.get("10.0.0.254").mac, net.node("R2").ifaces.eth0.mac);
});

test("with preempt the returning higher priority takes the address back; without it the backup keeps it", () => {
  const a = build(); a.setLink("R1:eth0", false); at(a, a.time + 5); a.setLink("R1:eth0", true); at(a, a.time + 8);
  assert.equal(st(a, "R1"), "master"); assert.equal(st(a, "R2"), "backup");
  const s = spec(); s.nodes[2].vrrp[0].preempt = false;
  const b = Network.fromSpec(s); at(b, 10); b.setLink("R1:eth0", false); at(b, b.time + 5); b.setLink("R1:eth0", true); at(b, b.time + 8);
  assert.equal(st(b, "R1"), "backup"); assert.equal(st(b, "R2"), "master");
});

test("priority 255 owns the address and is master from the start; equal priorities go to the higher address", () => {
  const s = spec(); s.nodes[2].vrrp[0].priority = 255; s.nodes[2].vrrp[0].ip = "10.0.0.1";
  const a = Network.fromSpec(s); at(a, 0.5); assert.equal(st(a, "R1"), "master");
  const t = spec({priority: 200}); const b = Network.fromSpec(t); at(b, 10);
  assert.equal(st(b, "R2"), "master"); assert.equal(st(b, "R1"), "backup");
});

test("the virtual MAC option answers with 00:00:5e:00:01:<vrid>", () => {
  const s = spec(); s.nodes[2].vrrp[0].virtualMac = true;
  const net = Network.fromSpec(s); at(net, 10);
  assert.ok(ping(net, "H1", "10.1.0.10").ok);
  assert.equal(net.node("H1").arp.get("10.0.0.254").mac, "00:00:5e:00:01:01");
});
