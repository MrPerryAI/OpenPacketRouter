import test from "node:test";
import assert from "node:assert/strict";
import {Network, ping, validateSpec} from "../src/index.js";

// A and B behind HUB (a plain switch), HUB -> SW1:p1 (limited), C on SW1:p2.
function build(cfg = {max: 1, violation: "restrict"}) {
  const net = new Network();
  net.addSwitch("SW1", {portSecurity: {p1: cfg}}); net.addSwitch("HUB");
  for (const [h, i] of [["A", 1], ["B", 2], ["C", 3]]) net.addHost(h, {ifaces: {eth0: `10.0.0.${i}/24`}});
  net.link("A:eth0", "HUB:p1"); net.link("B:eth0", "HUB:p2"); net.link("HUB:p3", "SW1:p1"); net.link("C:eth0", "SW1:p2");
  return net;
}
test("port security: the first address is secured, a second one is dropped and counted", () => {
  const net = build(); const sw = net.node("SW1");
  assert.equal(ping(net, "A", "10.0.0.3").ok, true);
  assert.equal(ping(net, "B", "10.0.0.3", {timeout: 2}).ok, false);
  const [p] = sw.portSecurity();
  assert.equal(p.secured.length, 1); assert.ok(p.violations >= 1); assert.equal(p.errdisabled, false);
  assert.ok(!sw.macTable().some(e => e.mac === net.node("B").ifaces.eth0.mac), "B was never learned");
  assert.equal(ping(net, "A", "10.0.0.3").ok, true);
});
test("port security: max 2 lets both through", () => {
  const net = build({max: 2});
  assert.equal(ping(net, "A", "10.0.0.3").ok, true); assert.equal(ping(net, "B", "10.0.0.3").ok, true);
  assert.equal(net.node("SW1").portSecurity()[0].violations, 0);
});
test("port security: shutdown takes the port down; clearing brings it back", () => {
  const net = build({max: 1, violation: "shutdown"}); const sw = net.node("SW1");
  ping(net, "A", "10.0.0.3"); assert.equal(ping(net, "B", "10.0.0.3").ok, false);
  assert.equal(sw.portSecurity()[0].errdisabled, true);
  assert.equal(ping(net, "A", "10.0.0.3").ok, false);   // the whole port is down
  sw.clearPortSecurity("p1");
  assert.equal(ping(net, "A", "10.0.0.3").ok, true);
});
test("port security: spec validation", () => {
  const spec = {version: 1, nodes: [{name: "S", kind: "switch", portSecurity: {p1: {max: 0}, p9: {max: 1, violation: "x"}}}, {name: "H", kind: "host", ifaces: {eth0: "10.0.0.1/24"}}], links: [["H:eth0", "S:p1"]]};
  const r = validateSpec(spec); const msgs = JSON.stringify(r);
  assert.ok(msgs.includes("portSecurity.p1") && msgs.includes("portSecurity.p9"), msgs);
});
