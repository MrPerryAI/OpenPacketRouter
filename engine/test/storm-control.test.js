import test from "node:test";
import assert from "node:assert/strict";
import {Network, validateSpec} from "../src/index.js";

function build(cfg = {rate: "8kbit", burst: 400}) {
  const net = new Network(); net.addSwitch("SW1", {stormControl: {p1: {broadcast: cfg}}});
  for (const [h, i] of [["A", 1], ["B", 2]]) net.addHost(h, {ifaces: {eth0: `10.0.0.${i}/24`}});
  net.link("A:eth0", "SW1:p1"); net.link("B:eth0", "SW1:p2");
  return net;
}
const burst = (net, n, size) => { const a = net.node("A"); for (let i = 0; i < n; i++) a.sendIp({dst: "255.255.255.255", ttl: 64, proto: "udp", udp: {sport: 5, dport: 9, payload: null, size}}); net.run(net.time + 0.01); };

test("storm control: a burst gets its first frames through (each costs the frame without its 14-byte header)", () => {
  const net = build(); burst(net, 10, 100);   // 142-byte frames cost 128: 400 / 128 = 3
  const [p] = net.node("SW1").stormControl();
  assert.equal(p.broadcast.passed, 3); assert.equal(p.broadcast.dropped, 7);
  assert.equal(net.diff(new Map())["SW1:p2>B:eth0"], 3);
});
test("storm control: the bucket refills with time, unicast and other ports are not limited", () => {
  const net = build(); burst(net, 10, 100); net.run(net.time + 1); burst(net, 3, 100);
  assert.equal(net.node("SW1").stormControl()[0].broadcast.dropped, 7);   // the second burst fits again
  const b = net.node("B"); b.sendIp({dst: "255.255.255.255", ttl: 64, proto: "udp", udp: {sport: 5, dport: 9, payload: null, size: 100}});
  net.run(net.time + 0.1); assert.equal(net.node("SW1").stormControl()[0].broadcast.dropped, 7);   // p2 has no limit
});
test("storm control: spec validation", () => {
  const spec = {version: 1, nodes: [{name: "S", kind: "switch", stormControl: {p1: {broadcast: {rate: "fast", burst: 0}}, p9: {broadcast: {rate: "1mbit", burst: 100}}}}, {name: "H", kind: "host", ifaces: {eth0: "10.0.0.1/24"}}], links: [["H:eth0", "S:p1"]]};
  const msgs = JSON.stringify(validateSpec(spec));
  assert.ok(msgs.includes("stormControl.p1") && msgs.includes("stormControl.p9"), msgs);
});
