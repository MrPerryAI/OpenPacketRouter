import test from "node:test";
import assert from "node:assert/strict";
import {Network} from "../src/index.js";
import {tcpAction} from "../src/tcp.js";

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
