import test from "node:test";
import assert from "node:assert/strict";
import {Network, ping} from "../src/index.js";

// two VLAN switches joined by a trunk; hosts A,C in VLAN 10, B,D in VLAN 20, E in VLAN 10 on SW2
function build() {
  const net = new Network();
  const v1 = {p1: {access: 10}, p2: {access: 20}, t: {trunk: [10, 20]}};
  net.addSwitch("SW1", {vlans: v1}); net.addSwitch("SW2", {vlans: {p1: {access: 10}, p2: {access: 20}, t: {trunk: [10, 20]}}});
  for (const [h, ip] of [["A", 1], ["B", 2], ["C", 3], ["D", 4]]) net.addHost(h, {ifaces: {eth0: `10.0.0.${ip}/24`}});
  net.link("A:eth0", "SW1:p1"); net.link("B:eth0", "SW1:p2"); net.link("C:eth0", "SW2:p1"); net.link("D:eth0", "SW2:p2");
  net.link("SW1:t", "SW2:t");
  return net;
}
test("VLANs: same VLAN across the trunk works, other VLAN is isolated", () => {
  const net = build();
  assert.equal(ping(net, "A", "10.0.0.3").ok, true);       // 10 -> 10 over the trunk
  assert.equal(ping(net, "A", "10.0.0.2", {timeout: 1}).ok, false);   // 10 -> 20: no L2 path
  assert.equal(ping(net, "B", "10.0.0.4").ok, true);
});
test("VLANs: trunk carries tagged frames; access ports carry untagged ones", () => {
  const net = build(); const seen = [];
  const orig = net.node("SW2").receive.bind(net.node("SW2"));
  net.node("SW2").receive = (i, f) => { if (i === "t") seen.push(f.vlan); orig(i, f); };
  ping(net, "A", "10.0.0.3"); net.settle();
  assert.ok(seen.length && seen.every(v => v === 10));
});
test("VLANs: broadcast stays in its VLAN", () => {
  const net = build(); ping(net, "A", "10.0.0.3"); net.settle();
  assert.equal(net.counters.get("SW1:p2>B:eth0"), undefined);
  assert.equal(net.counters.get("SW2:p2>D:eth0"), undefined);
});
test("VLANs: native VLAN rides the trunk untagged; a trunk drops VLANs it doesn't allow", () => {
  const net = new Network(); const seen = [];
  net.addSwitch("S1", {vlans: {p1: {access: 5}, t: {trunk: [10], native: 5}}}); net.addSwitch("S2", {vlans: {p1: {access: 5}, t: {trunk: [10], native: 5}}});
  net.addHost("A", {ifaces: {eth0: "10.0.0.1/24"}}); net.addHost("B", {ifaces: {eth0: "10.0.0.2/24"}});
  net.link("A:eth0", "S1:p1"); net.link("B:eth0", "S2:p1"); net.link("S1:t", "S2:t");
  const o = net.node("S2").receive.bind(net.node("S2")); net.node("S2").receive = (i, f) => { if (i === "t") seen.push(f.vlan); o(i, f); };
  assert.equal(ping(net, "A", "10.0.0.2").ok, true);
  assert.ok(seen.every(v => v === undefined));
  const net2 = new Network();
  net2.addSwitch("S1", {vlans: {p1: {access: 10}, t: {trunk: [10]}}}); net2.addSwitch("S2", {vlans: {p1: {access: 10}, t: {trunk: [20]}}});
  net2.addHost("A", {ifaces: {eth0: "10.0.0.1/24"}}); net2.addHost("B", {ifaces: {eth0: "10.0.0.2/24"}});
  net2.link("A:eth0", "S1:p1"); net2.link("B:eth0", "S2:p1"); net2.link("S1:t", "S2:t");
  assert.equal(ping(net2, "A", "10.0.0.2", {timeout: 1}).ok, false);
});
