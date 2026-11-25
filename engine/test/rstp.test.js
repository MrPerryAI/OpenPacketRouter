import test from "node:test";
import assert from "node:assert/strict";
import {Network, ping} from "../src/index.js";

// Rapid spanning tree (engine/src/rstp.js). The frame-for-frame checks against mstpd are in validate/rstp/ (CI only);
// these tests pin the behaviour the port was written for.
const R = {mode: "rstp", hello: 2, maxAge: 6, forwardDelay: 4};
function triangle(extra = {}, modes = {}) {
  const net = new Network();
  net.addSwitch("SW1", {stp: {mac: "02:aa:00:00:00:01", ...R, ...modes.SW1}});
  net.addSwitch("SW2", {stp: {mac: "02:aa:00:00:00:02", ...R, ...modes.SW2}});
  net.addSwitch("SW3", {stp: {mac: "02:aa:00:00:00:03", ...R, ...modes.SW3}, ...extra});
  net.addHost("A", {ifaces: {eth0: "10.0.0.1/24"}}); net.addHost("B", {ifaces: {eth0: "10.0.0.2/24"}});
  net.link("SW1:p1", "SW2:p1"); net.link("SW2:p2", "SW3:p1"); net.link("SW3:p2", "SW1:p2");
  net.link("A:eth0", "SW1:p3"); net.link("B:eth0", "SW3:p3");
  return net;
}
const roles = net => Object.fromEntries(["SW1", "SW2", "SW3"].map(s => [s, Object.fromEntries(Object.entries(net.node(s).stp.describe().ports).map(([p, v]) => [p, v.role + "/" + v.state]))]));
const bpdus = net => { const seen = []; net.taps.add((node, ifname, f) => { if (f.type === "bpdu") seen.push({at: net.time, from: `${node.name}:${ifname}`, kind: f.bpdu.tcn ? "tcn" : f.bpdu.version >= 2 ? f.bpdu.flags : "config"}); }); return seen; };

test("RSTP: the triangle converges in moments, with one alternate port and no timers", () => {
  const net = triangle(); net.run(0.5);
  const r = roles(net);
  assert.deepEqual(r.SW1, {p1: "designated/forwarding", p2: "designated/forwarding", p3: "designated/discarding"});
  assert.deepEqual(r.SW2, {p1: "root/forwarding", p2: "designated/forwarding"});
  assert.deepEqual(r.SW3, {p1: "alternate/discarding", p2: "root/forwarding", p3: "designated/discarding"});
  assert.equal(net.node("SW3").stp.describe().rootCost, 20000);
  assert.equal(net.node("SW1").stp.describe().mode, "rstp");
});

test("RSTP: a host port with no BPDUs becomes an edge port after the migration delay (3 s) and forwards at once; an admin edge port from the start", () => {
  const net = triangle({}, {SW1: {edge: {p3: true}}}); net.run(0.5);
  assert.equal(roles(net).SW1.p3, "designated/forwarding");
  assert.equal(net.node("SW1").stp.describe().ports.p3.edge, true);
  assert.equal(roles(net).SW3.p3, "designated/discarding");
  net.run(4);
  assert.equal(roles(net).SW3.p3, "designated/forwarding");
  assert.equal(net.node("SW3").stp.describe().ports.p3.edge, true);
});

test("RSTP: an edge port stops being one when a BPDU arrives (a switch was plugged in)", () => {
  const net = triangle({}, {SW1: {edge: {p4: true}}});
  net.addSwitch("SW9", {stp: {mac: "02:aa:00:00:00:09", ...R}});
  net.link("SW9:p1", "SW1:p4"); net.setLink("SW9:p1", false); net.run(5);   // (the cable is cut until now)
  assert.equal(net.node("SW1").stp.describe().ports.p4.edge, true, "an admin edge port is an edge port while nothing is plugged in");
  net.setLink("SW9:p1", true); net.run(net.time + 0.1);
  assert.equal(net.node("SW1").stp.describe().ports.p4.edge, false, "the first BPDU shows the neighbour is a bridge: the port stops being an edge port");
  net.run(net.time + 1);
  assert.equal(net.node("SW1").stp.describe().ports.p4.state, "forwarding", "...and it still comes up fast, by proposal and agreement");
});

test("RSTP: when the root port's cable is cut the alternate port takes over at once", () => {
  const net = triangle(); net.run(10);
  assert.equal(roles(net).SW3.p1, "alternate/discarding");
  net.setLink("SW3:p2", false); net.run(net.time + 0.1);
  const r = roles(net);
  assert.deepEqual(r.SW3, {p1: "root/forwarding", p2: "disabled/disabled", p3: "designated/forwarding"});
  assert.equal(net.node("SW3").stp.describe().rootCost, 40000);
  const reply = ping(net, "A", "10.0.0.2", {timeout: 2});
  assert.equal(reply.ok, true);
});

test("RSTP: a returning cable is brought in by proposal and agreement, with no forward delay", () => {
  const net = triangle(); net.run(10);
  net.setLink("SW1:p1", false); net.run(net.time + 1);
  net.setLink("SW1:p1", true); net.run(net.time + 0.1);
  const r = roles(net);
  assert.equal(r.SW1.p1, "designated/forwarding"); assert.equal(r.SW2.p1, "root/forwarding");
  assert.equal(r.SW3.p1, "alternate/discarding");
});

test("RSTP: steady-state BPDUs: a designated forwarding port sends flags 0x7c every hello, a root port sends none", () => {
  const net = triangle(); net.run(12);
  const seen = bpdus(net); net.run(net.time + 6);
  const kinds = k => [...new Set(seen.filter(s => s.from === k).map(s => s.kind))];
  assert.deepEqual(kinds("SW1:p1"), [0x7c]);
  assert.deepEqual(kinds("SW2:p1"), []);
  assert.deepEqual(kinds("SW3:p3"), [0x7e]);        // the edge port keeps proposing (nobody ever agrees)
  assert.equal(seen.filter(s => s.from === "SW1:p1").length, 3);   // one per hello (2 s)
});

test("RSTP: a topology change flushes the MAC table of the other ports and sets the TC flag for hello + 1 s", () => {
  const net = triangle(); net.run(10);
  ping(net, "A", "10.0.0.2", {timeout: 2});
  assert.ok(net.node("SW2").macTable().length > 0);
  const seen = bpdus(net);
  net.setLink("SW1:p2", false); net.run(net.time + 0.1);
  assert.equal(net.node("SW2").stp.describe().topologyChange, true);
  assert.ok(seen.some(s => (s.kind & 1) === 1), "a BPDU carried the TC flag");
  assert.equal(net.node("SW2").macTable().filter(e => e.port === "p1").length, 0, "entries learned on ports other than the one the change came in on are flushed");
  assert.ok(net.node("SW2").macTable().some(e => e.port === "p2"), "the port the change came in on keeps its entries");
  net.run(net.time + 5);
  assert.equal(net.node("SW2").stp.describe().topologyChange, false);
  assert.equal(net.node("SW2").holdTime(), net.node("SW2").agingTime, "RSTP does not shorten MAC aging like classic STP");
});

test("RSTP: next to a classic STP bridge the port falls back to classic BPDUs and the network still converges", () => {
  const net = triangle({}, {SW2: {mode: "stp", hello: 1, maxAge: 6, forwardDelay: 4}}); net.run(40);
  const r = roles(net);
  assert.equal(net.node("SW1").stp.isRoot(), true);
  assert.equal(r.SW2.p1, "root/forwarding");
  assert.equal(ping(net, "A", "10.0.0.2", {timeout: 2}).ok, true);
  const forwarding = Object.values(r).flatMap(x => Object.values(x)).filter(x => x.endsWith("/forwarding")).length;
  assert.ok(forwarding >= 7, `one port blocks: ${JSON.stringify(r)}`);
});

test("RSTP: the lower bridge id wins, a lower priority overrides it", () => {
  const net = triangle({}, {SW3: {priority: 4096}}); net.run(2);
  assert.equal(net.node("SW3").stp.isRoot(), true);
  assert.equal(net.node("SW1").stp.describe().root.startsWith("1000."), true);
});
