import test from "node:test";
import assert from "node:assert/strict";
import {Network} from "../src/index.js";
import {tcpAction} from "../src/tcp.js";
import {shape} from "../src/link.js";

function lan() {
  const net = new Network(); net.addSwitch("SW");
  net.addHost("C", {ifaces: {eth0: "10.0.0.1/24"}});
  net.addServer("S", {ifaces: {eth0: "10.0.0.2/24"}, services: {tcp: {7: "echo"}}});
  net.link("C:eth0", "SW:p1"); net.link("S:eth0", "SW:p2"); return net;
}
const act = (net, a) => tcpAction(net, {src: "C", dst: "10.0.0.2", port: 7, ...a});

test("TCP: handshake, echo, and a three-segment close", () => {
  const r = act(lan(), {size: 100});
  assert.equal(r.ok, true); assert.equal(r.bytes, 100);
  assert.deepEqual(r.wire, ["out S", "in SA", "out A", "out PA 100", "in A", "in PA 100", "out A", "out FA", "in FA", "out A"]);
});
test("TCP: a closed port answers RST+ACK and the client sees 'refused'", () => {
  const r = act(lan(), {port: 8});
  assert.equal(r.error, "refused"); assert.deepEqual(r.wire, ["out S", "in RA"]);
});
test("TCP: an unanswered SYN is retransmitted at 1 s and 3 s", () => {
  const net = new Network(); net.addSwitch("SW");
  net.addHost("C", {ifaces: {eth0: "10.0.0.1/24"}}); net.addHost("H", {ifaces: {eth0: "10.0.0.2/24"}});   // H has no TCP service and drops nothing... until we cut its replies
  net.link("C:eth0", "SW:p1"); net.link("H:eth0", "SW:p2");
  const times = []; net.taps = new Set([(n, i, f) => { if (n.name === "C" && f.ip?.proto === "tcp") times.push(+net.time.toFixed(3)); }]);
  net.node("H").tcpInput = null;
  net.node("H").deliver = () => {};                      // a host that silently ignores everything
  const r = act(net, {timeout: 4});
  assert.equal(r.error, "timeout");
  assert.equal(times.filter((t, k) => k === 0 || t - times[0] > 0.5).length >= 3, true);
  assert.deepEqual(r.wire, ["out S", "out S", "out S"]);
});

function lossy(limit = 1600) {   // the switch's port toward S queues at most `limit` bytes
  const net = new Network(); net.addSwitch("SW");
  net.addHost("C", {ifaces: {eth0: "10.0.0.1/24"}});
  net.addServer("S", {ifaces: {eth0: "10.0.0.2/24"}, services: {tcp: {7: "echo", 9: "discard"}}});
  net.link("C:eth0", "SW:p1"); net.link("S:eth0", "SW:p2"); shape(net, "SW:p2", {rate: "10mbit", burst: 1700, limit}); return net;
}
const dataTimes = net => { const t = []; net.taps = new Set([(n, i, f) => { if (n.name === "C" && f.ip?.proto === "tcp" && f.ip.tcp.len) t.push(net.time); }]); return t; };
test("TCP: a write is cut into 1448-byte segments, PSH on the last", () => {
  const r = act(lossy(5000), {port: 9, size: 3000, discard: true});
  assert.deepEqual(r.wire.filter(w => /^out \w+ \d+$/.test(w)), ["out A 1448", "out A 1448", "out PA 104"]);
});
test("TCP: a segment dropped on the way is retransmitted after 200 ms, then the close", () => {
  const net = lossy(), t = dataTimes(net);
  const r = act(net, {port: 9, size: 3000, discard: true, pause: 1});
  assert.equal(r.ok, true);
  assert.deepEqual(r.wire, ["out S", "in SA", "out A", "out A 1448", "out A 1448", "out PA 104", "in A", "in A", "out PA 104", "in A", "out FA", "in FA", "out A"]);
  assert.ok(t[3] - t[2] > 0.19 && t[3] - t[2] < 0.22, `retransmitted after ${t[3] - t[2]} s`);
});
test("TCP: the retransmission timer doubles while nothing is acknowledged", () => {
  const net = lossy(100), t = dataTimes(net);               // every data segment is dropped
  const r = act(net, {port: 9, size: 100, discard: true, pause: 2});
  assert.equal(r.ok, true);
  assert.deepEqual(t.map(x => +(x - t[0]).toFixed(1)), [0, 0.2, 0.6, 1.4]);
});
