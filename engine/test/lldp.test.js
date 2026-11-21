import test from "node:test";
import assert from "node:assert/strict";
import {Network, validateSpec, runActions} from "../src/index.js";

const spec = (extra = {}, sw = {}) => ({version: 1, nodes: [
  {name: "R1", kind: "router", ifaces: {eth0: "10.0.0.1/24"}, lldp: {txInterval: 5, holdMultiplier: 2}},
  {name: "H2", kind: "host", ifaces: {eth0: "10.0.0.2/24"}, lldp: {txInterval: 5, holdMultiplier: 2}},
  {name: "SW", kind: "switch", ...sw}], links: [["R1:eth0", "SW:p1", 1], ["H2:eth0", "SW:p2", 1]], ...extra});
const at = (net, t) => { net.run(t); if (net.time < t) net.time = t; };
const nb = (net, n) => net.node(n).lldp.neighbors();

test("a switch does not forward LLDP: no neighbors across it", () => {
  const net = Network.fromSpec(spec()); at(net, 20);
  assert.equal(nb(net, "R1").length, 0); assert.equal(nb(net, "H2").length, 0);
});

test("directly cabled neighbors learn each other's chassis, port, name and TTL", () => {
  const net = Network.fromSpec({version: 1, nodes: [
    {name: "R1", kind: "router", ifaces: {eth0: "10.0.0.1/24"}, lldp: {txInterval: 5, holdMultiplier: 2}},
    {name: "H2", kind: "host", ifaces: {eth0: "10.0.0.2/24"}, lldp: {txInterval: 5, holdMultiplier: 3}}], links: [["R1:eth0", "H2:eth0", 1]]});
  at(net, 3);
  const n = nb(net, "R1")[0];
  assert.equal(n.sysName, "H2"); assert.equal(n.portDescr, "eth0"); assert.equal(n.ttl, 15); assert.deepEqual(n.caps, ["station"]);
  assert.equal(n.chassisId, net.node("H2").ifaces.eth0.mac); assert.equal(nb(net, "H2")[0].ttl, 10); assert.deepEqual(nb(net, "H2")[0].caps, ["router"]);
});

test("a forwarding switch carries LLDP; cutting a far cable ages the neighbor out after the TTL, the near end drops it at once", () => {
  const net = Network.fromSpec(spec({}, {forwardLldp: true})); at(net, 12);
  assert.equal(nb(net, "R1").length, 1); assert.equal(nb(net, "H2").length, 1);
  net.setLink("SW:p2", false); at(net, 14);
  assert.equal(nb(net, "H2").length, 0, "carrier lost: cleared at once"); assert.equal(nb(net, "R1").length, 1, "still within the TTL");
  at(net, 30); assert.equal(nb(net, "R1").length, 0, "TTL 10 s passed");
  net.setLink("SW:p2", true); at(net, 33);
  assert.equal(nb(net, "R1").length, 1); assert.equal(nb(net, "H2").length, 1);
});

test("the first LLDPDU leaves 1 s after start, then every txInterval", () => {
  const net = Network.fromSpec(spec({}, {forwardLldp: true})); const times = [];
  net.taps.add((n, i, f) => { if (n.name === "R1" && f.type === "lldp") times.push(+net.time.toFixed(3)); });
  at(net, 12); assert.deepEqual(times, [1, 6, 11]);
});

test("lldp spec keys are checked", () => {
  const bad = spec(); bad.nodes[0].lldp = {txInterval: 0, bogus: 1};
  const r = validateSpec(bad); assert.ok(r.errors.some(e => /txInterval/.test(e.message)) && r.errors.some(e => /bogus/.test(e.message)));
  const sw = spec({}, {forwardLldp: "yes"}); assert.ok(validateSpec(sw).errors.some(e => /forwardLldp/.test(e.message)));
  assert.equal(validateSpec(spec({}, {forwardLldp: true})).errors.length, 0);
});

test("the lldpNeighbors action returns the table", () => {
  const r = runActions(spec({}, {forwardLldp: true}), [{do: "wait", seconds: 12}, {do: "lldpNeighbors", src: "R1"}]);
  assert.equal(r[1].result.neighbors[0].sysName, "H2");
});
