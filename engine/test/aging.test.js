import test from "node:test";
import assert from "node:assert/strict";
import {Network, ping, validateSpec} from "../src/index.js";

// A, B on SW1; C on SW2. SW1 ages entries after 5 s, SW2 after 12 s.
function build(aging1 = 5, aging2 = 12) {
  const net = new Network();
  net.addSwitch("SW1", {agingTime: aging1 ?? undefined}); net.addSwitch("SW2", {agingTime: aging2 ?? undefined});
  for (const [h, i] of [["A", 1], ["B", 2], ["C", 3]]) net.addHost(h, {ifaces: {eth0: `10.0.0.${i}/24`}});
  net.link("A:eth0", "SW1:p1"); net.link("B:eth0", "SW1:p2"); net.link("SW1:p3", "SW2:p1"); net.link("C:eth0", "SW2:p2");
  return net;
}
const ports = sw => Object.fromEntries(sw.macTable().map(e => [e.mac, e.port]));

test("aging: entries are learned, then expire after the aging time", () => {
  const net = build(); ping(net, "A", "10.0.0.3"); net.settle(1);
  const sw1 = net.node("SW1");
  assert.equal(sw1.macTable().length, 2);
  net.run(net.time + 3); assert.equal(sw1.macTable().length, 2);
  net.run(net.time + 3); assert.equal(sw1.macTable().length, 0);
  assert.equal(net.node("SW2").macTable().length, 2);   // 12 s: still there
});
test("aging: each switch has its own aging time", () => {
  const net = build(5, 12); ping(net, "A", "10.0.0.3"); net.settle(1); net.run(net.time + 13);
  assert.equal(net.node("SW1").macTable().length, 0); assert.equal(net.node("SW2").macTable().length, 0);
});
test("aging: traffic refreshes an entry", () => {
  const net = build(); ping(net, "A", "10.0.0.3"); net.settle(1); net.run(net.time + 3);
  ping(net, "C", "10.0.0.1"); net.settle(1);        // both A and C talk again
  net.run(net.time + 3);                           // 6+ s after the first ping, but only ~4 s since the refresh
  assert.equal(net.node("SW1").macTable().length, 2);
  assert.ok(net.node("SW1").macTable().every(e => e.age < 5));
});
test("aging: after expiry the switch floods instead of forwarding, then relearns", () => {
  const net = build(); ping(net, "A", "10.0.0.3"); net.settle(1);
  const b = () => net.counters.get("SW1:p2>B:eth0") || 0;
  const before = b();
  ping(net, "C", "10.0.0.1"); net.settle(1); assert.equal(b(), before, "unicast while the entry is fresh: B sees nothing");
  net.run(net.time + 6);                           // SW1 forgot A; the hosts' ARP caches still know each other
  ping(net, "C", "10.0.0.1"); net.settle(1); assert.equal(b(), before + 1, "unknown destination is flooded to B");
  const mid = b();
  ping(net, "C", "10.0.0.1"); net.settle(1); assert.equal(b(), mid, "learned again: unicast");
});
test("aging: default is 300 seconds", () => {
  const net = build(null, null); ping(net, "A", "10.0.0.3"); net.settle(1);
  net.run(net.time + 290); assert.equal(net.node("SW1").macTable().length, 2);
  net.run(net.time + 20); assert.equal(net.node("SW1").macTable().length, 0);
});
test("aging: the table lists the age of each entry; an aged-out MAC is logged", () => {
  const net = build(); ping(net, "A", "10.0.0.3"); net.settle(1); net.run(net.time + 2);
  assert.ok(net.node("SW1").macTable().every(e => e.age >= 2 && e.age < 4));
  net.run(net.time + 10); net.node("SW1").macTable();
  assert.ok(net.trace.some(t => t.event === "age-out"));
});
test("spec: agingTime is validated", () => {
  const spec = a => ({version: 1, nodes: [{name: "SW", kind: "switch", agingTime: a}], links: []});
  assert.equal(validateSpec(spec(30)).ok, true);
  for (const bad of [0, -1, "30", null, NaN]) assert.equal(validateSpec(spec(bad)).ok, false, String(bad));
  assert.equal(validateSpec({version: 1, nodes: [{name: "H", kind: "host", agingTime: 30}], links: []}).warnings.length > 0, true);
});
