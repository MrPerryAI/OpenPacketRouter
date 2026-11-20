import test from "node:test";
import assert from "node:assert/strict";
import {Network, ping} from "../src/index.js";

const T = {hello: 1, maxAge: 6, forwardDelay: 4};
// SW1 (root) - SW2 - SW3 in a line, host A on SW1, B on SW3; MAC aging 30 s
function line() {
  const net = new Network();
  for (const [n, m] of [["SW1", 1], ["SW2", 2], ["SW3", 3]]) net.addSwitch(n, {agingTime: 30, stp: {mac: `02:aa:00:00:00:0${m}`, ...T}});
  net.addHost("A", {ifaces: {eth0: "10.0.0.1/24"}}); net.addHost("B", {ifaces: {eth0: "10.0.0.2/24"}});
  net.link("SW1:p1", "SW2:p1"); net.link("SW2:p2", "SW3:p1"); net.link("A:eth0", "SW1:p3"); net.link("B:eth0", "SW3:p3");
  return net;
}
const tc = (net, n) => net.node(n).stp.tc;
const tcns = (net, sw) => net.trace.filter(e => e.node === sw && /sending a TCN/.test(e.detail)).length;

test("TCN: a port reaching forwarding makes a bridge send a TCN up its root port; the root acks and sets the flag everywhere", () => {
  const net = line(); net.run(12);   // ports reach forwarding at 8 s
  assert.ok(tcns(net, "SW3") >= 1 && tcns(net, "SW2") >= 1, "non-root bridges send TCNs");
  assert.equal(tcns(net, "SW1"), 0, "the root has nobody to send one to");
  for (const n of ["SW1", "SW2", "SW3"]) assert.equal(tc(net, n), true, `${n} has the topology-change flag`);
  assert.equal(net.node("SW3").stp.tcd, false, "the TCN was acknowledged");
});
test("TCN: the flag clears forward-delay + max-age after the last notice", () => {
  const net = line(); net.run(12);
  net.run(30);
  for (const n of ["SW1", "SW2", "SW3"]) assert.equal(tc(net, n), false);
  assert.equal(net.node("SW1").stp.tcd, false);
});
test("TCN: a repeated TCN is sent every hello until it is acknowledged (no ack while the root is silent)", () => {
  const net = line(); net.run(30);
  net.node("SW1").stp._cancel("hello"); net.node("SW1").stp.receive = () => {};   // the root goes deaf and silent: no acknowledgement can arrive
  const before = tcns(net, "SW2"); net.node("SW2").stp._topologyChange(); net.run(net.time + 5.5);   // SW3's would be acknowledged by SW2, its designated bridge
  assert.ok(tcns(net, "SW2") - before >= 4, `repeated about once a second (sent ${tcns(net, "SW2") - before})`);
});
test("TCN: while the flag is set MAC entries last one forward delay instead of the aging time", () => {
  const net = line(); net.run(40);                    // flag cleared
  ping(net, "A", "10.0.0.2"); net.settle(1);
  const sw = net.node("SW2");
  assert.equal(sw.macTable().filter(e => e.mac === net.node("A").ifaces.eth0.mac).length, 1);
  net.setLink("SW3:p3", false);                      // a link change somewhere makes SW3's designated port... SW3 just loses a port; force a notice
  net.node("SW3").stp._topologyChange();
  net.run(net.time + 4);
  assert.equal(tc(net, "SW2"), true);
  const a = sw.macTable().find(e => e.mac === net.node("A").ifaces.eth0.mac);
  assert.ok(!a || a.stale, "older than one forward delay: expired while the flag is on");
  net.run(net.time + 30);
  assert.equal(tc(net, "SW2"), false); assert.equal(sw.holdTime(), 30);
});
test("TCN: Linux does not flush the table on a topology change (entries are only aged faster)", () => {
  const net = line(); net.run(40); ping(net, "A", "10.0.0.2"); net.settle(1);
  const hosts = () => net.node("SW2").macTable().filter(e => [net.node("A").ifaces.eth0.mac, net.node("B").ifaces.eth0.mac].includes(e.mac)).length;
  assert.equal(hosts(), 2);
  net.node("SW3").stp._topologyChange(); net.run(net.time + 1);
  assert.equal(net.node("SW2").stp.tc, true); assert.equal(hosts(), 2);
});
test("TCN: a switch learns the sender of a BPDU, like a kernel bridge", () => {
  const net = line(); net.run(12);
  assert.ok(net.node("SW2").macTable().some(e => e.mac === net.node("SW1").ifaces.p1.mac && e.port === "p1"));
});
test("TCN: a TCN arriving on a port that is not designated is ignored", () => {
  const net = line(); net.run(40);
  const sw1 = net.node("SW1"), before = tc(net, "SW1");
  sw1.stp.receive("p1", {bpdu: {tcn: true}}); // p1 of the root IS designated: acknowledged
  assert.equal(tc(net, "SW1"), true); assert.equal(before, false);
  const sw3 = net.node("SW3"); net.run(net.time + 30);
  sw3.stp.receive("p1", {bpdu: {tcn: true}}); // SW3's p1 is its root port: ignored
  assert.equal(tc(net, "SW3"), false);
});
