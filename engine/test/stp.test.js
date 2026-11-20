import test from "node:test";
import assert from "node:assert/strict";
import {Network, ping} from "../src/index.js";

const T = {hello: 1, maxAge: 6, forwardDelay: 4};
// three switches in a triangle; SW1 has the lowest bridge id and becomes root
function triangle(extra = {}) {
  const net = new Network();
  net.addSwitch("SW1", {stp: {mac: "02:aa:00:00:00:01", ...T}});
  net.addSwitch("SW2", {stp: {mac: "02:aa:00:00:00:02", ...T}});
  net.addSwitch("SW3", {stp: {mac: "02:aa:00:00:00:03", ...T}, ...extra});
  net.addHost("A", {ifaces: {eth0: "10.0.0.1/24"}}); net.addHost("B", {ifaces: {eth0: "10.0.0.2/24"}});
  net.link("SW1:p1", "SW2:p1"); net.link("SW2:p2", "SW3:p1"); net.link("SW3:p2", "SW1:p2");
  net.link("A:eth0", "SW1:p3"); net.link("B:eth0", "SW3:p3");
  return net;
}
const roles = net => Object.fromEntries(["SW1", "SW2", "SW3"].map(s => [s, Object.fromEntries(Object.entries(net.node(s).stp.describe().ports).map(([p, v]) => [p, v.role + "/" + v.state]))]));

test("STP: lowest bridge id is root; the highest-id bridge blocks one triangle port", () => {
  const net = triangle(); net.run(30);
  const r = roles(net);
  assert.equal(net.node("SW1").stp.isRoot(), true);
  assert.deepEqual(r.SW1, {p1: "designated/forwarding", p2: "designated/forwarding", p3: "designated/forwarding"});
  assert.deepEqual(r.SW2, {p1: "root/forwarding", p2: "designated/forwarding"});
  assert.deepEqual(r.SW3, {p1: "blocked/blocking", p2: "root/forwarding", p3: "designated/forwarding"});
  assert.equal(net.node("SW3").stp.describe().rootCost, 19);
});

test("STP: a ping crosses the tree and the loop does not storm", () => {
  const net = triangle(); net.run(30);
  assert.equal(ping(net, "A", "10.0.0.2").ok, true);
  net.settle(); assert.ok(net.events < 5000);
});

test("STP: blocked ports hold data until the forward delay has passed (listening, learning, forwarding)", () => {
  const net = triangle(); net.run(3);
  assert.equal(net.node("SW1").stp.describe().ports.p1.state, "listening");
  assert.equal(ping(net, "A", "10.0.0.2", {timeout: 0.5}).ok, false);
});

test("STP: path cost beats bridge id; priority moves the root", () => {
  const net = new Network();
  net.addSwitch("SW1", {stp: {mac: "02:aa:00:00:00:01", ...T}});
  net.addSwitch("SW2", {stp: {mac: "02:aa:00:00:00:02", priority: 4096, ...T}});
  net.link("SW1:p1", "SW2:p1"); net.run(20);
  assert.equal(net.node("SW2").stp.isRoot(), true);
  assert.equal(net.node("SW1").stp.describe().ports.p1.role, "root");
});

test("STP: cutting the root link reconverges through the blocked port", () => {
  const net = triangle(); net.run(30);
  net.setLink("SW3:p2", false); net.run(net.time + 20);
  assert.equal(roles(net).SW3.p1, "root/forwarding");
  assert.equal(ping(net, "A", "10.0.0.2").ok, true);
});

test("STP: BPDUs that stop arriving (silent failure) age out after max-age and the survivor becomes root", () => {
  const net = new Network();
  net.addSwitch("S1", {stp: {mac: "02:aa:00:00:00:01", ...T}}); net.addSwitch("HUB"); net.addSwitch("S2", {stp: {mac: "02:aa:00:00:00:02", ...T}});
  net.link("S1:p1", "HUB:a"); net.link("HUB:b", "S2:p1"); net.run(20);
  assert.equal(net.node("S2").stp.isRoot(), false);
  net.node("S1").stp._cancel("hello");   // S1 goes quiet but its link stays up
  const t0 = net.time;
  // S2's stored root information expires about max-age after the last BPDU (one held back by the 1 s hold timer
  // may still arrive after S1 goes quiet); the moment it does, S2 declares itself root.
  const expired = () => net.trace.some(e => e.node === "S2" && e.t > t0 && /information expired/.test(e.detail));
  for (let t = t0; !expired() && t < t0 + T.maxAge + 2; ) net.run(t += 0.001);
  assert.ok(expired());
  assert.ok(net.time - t0 > T.maxAge - 1 && net.time - t0 < T.maxAge + 2);
  assert.equal(net.node("S2").stp.isRoot(), true);
});

test("STP off: a plain switch floods BPDUs like Linux does (hub behaviour)", () => {
  const net = new Network();
  net.addSwitch("S1", {stp: {mac: "02:aa:00:00:00:01", ...T}}); net.addSwitch("HUB"); net.addSwitch("S2", {stp: {mac: "02:aa:00:00:00:02", ...T}});
  net.link("S1:p1", "HUB:a"); net.link("HUB:b", "S2:p1"); net.run(20);
  assert.equal(net.node("S2").stp.describe().rootPort, "p1");
});
