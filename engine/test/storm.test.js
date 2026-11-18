import test from "node:test";
import assert from "node:assert/strict";
import {Network, stormAnalysis} from "../src/index.js";

// Switches S0..S(n-1) joined by `pairs` (cables with 1 ms delay), a host on S0.
function switches(n, pairs, {blocked = {}} = {}) {
  const net = new Network();
  for (let i = 0; i < n; i++) net.addSwitch(`S${i}`, {blocked: blocked[`S${i}`] || []});
  net.addHost("H", {ifaces: {eth0: "10.0.0.1/24"}});
  pairs.forEach(([a, b], k) => net.link(`S${a}:p${k}a`, `S${b}:p${k}b`, {delay: 0.001}));
  net.link("H:eth0", "S0:h");
  return net;
}

test("a tree of switches: TREE, rho 0, nothing reached", () => {
  const r = stormAnalysis(switches(4, [[0, 1], [1, 2], [1, 3]]));
  assert.equal(r.regime, "TREE"); assert.equal(r.rho, 0);
  assert.deepEqual(r.reachEdges, []); assert.equal(r.doublingTime, null);
});

test("a ring: CIRCULATING, rho 1; the host hangs off it and is reached", () => {
  const r = stormAnalysis(switches(3, [[0, 1], [1, 2], [2, 0]]));
  assert.equal(r.regime, "CIRCULATING"); assert.ok(Math.abs(r.rho - 1) < 1e-9);
  assert.equal(r.loopEdges.length, 6);                 // both directions of all three cables
  assert.deepEqual(r.hostsReached, ["H"]);
  assert.ok(r.reachEdges.includes("S0:h>H:eth0"));
});

test("blocking one ring port (like STP) makes it a tree again", () => {
  const r = stormAnalysis(switches(3, [[0, 1], [1, 2], [2, 0]], {blocked: {S2: ["p1b"]}}));
  assert.equal(r.regime, "TREE");
});

test("a cut cable counts too: setLink(down) breaks the loop", () => {
  const net = switches(3, [[0, 1], [1, 2], [2, 0]]);
  net.setLink("S0:p0a", false);
  assert.equal(stormAnalysis(net).regime, "TREE");
});

test("full mesh of 4 switches amplifies: rho 2, growth from the renewal equation", () => {
  const r = stormAnalysis(switches(4, [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]]));
  assert.equal(r.regime, "AMPLIFYING");
  assert.ok(Math.abs(r.rho - 2) < 1e-9, `rho ${r.rho}`);
  // every edge has the same hop delay d, so rho(exp(-r d) B) = 1  =>  r = ln(2) / d
  const d = 672 / 100e6 + 0.001 + 5e-6;
  assert.ok(Math.abs(r.doublingTime - d) / d < 1e-6, `doubling ${r.doublingTime} vs ${d}`);
});

test("two parallel cables between two switches: the classic 2-cycle loop, rho 1", () => {
  const r = stormAnalysis(switches(2, [[0, 1], [0, 1]]));
  assert.equal(r.regime, "CIRCULATING");
});
