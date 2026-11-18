import test from "node:test";
import assert from "node:assert/strict";
import {runActions, validateSpec, parseRate, frameBytes} from "../src/index.js";

const spec = shape => ({nodes: [{name: "SW", kind: "switch"},
  {name: "A", kind: "host", ifaces: {eth0: "10.0.0.1/24"}}, {name: "B", kind: "host", ifaces: {eth0: "10.0.0.2/24"}}],
  links: [["A:eth0", "SW:p1", 1, {shape}], ["B:eth0", "SW:p2", 1]]});

test("rates and frame sizes are counted like tc and Linux", () => {
  assert.equal(parseRate("100kbit"), 1e5); assert.equal(parseRate("1mbit"), 1e6); assert.equal(parseRate("10kbps"), 8e4);
  assert.equal(frameBytes({type: "ipv4", ip: {proto: "udp", udp: {size: 1000}}}), 1042);
  assert.equal(frameBytes({type: "arp", arp: {}}), 42);
});

test("token bucket: burst goes straight out, the queue holds what fits, the rest is dropped", () => {
  // burst 2500 B: the ARP request (42) + 2 datagrams (1042 each); queue 5000 B: 4 more; 14 dropped
  const [r] = runActions(spec({rate: "100kbit", burst: 2500, limit: 5000}), [{do: "udpBurst", src: "A", dst: "10.0.0.2", port: 9, count: 20, size: 1000, settle: 2}]);
  assert.equal(r.frames["A:eth0>SW:p1"], 7);
  assert.deepEqual(r.drops, {"A:eth0": 14});
});

test("queued frames leave at the shaped rate", () => {
  const [r] = runActions(spec({rate: "100kbit", burst: 2500, limit: 5000}), [{do: "udpBurst", src: "A", dst: "10.0.0.2", port: 9, count: 6, size: 1000, settle: 0.2}], {trace: true});
  // after 0.2 s only the burst and two queued frames (83.36 ms each) have left
  assert.equal(r.frames["A:eth0>SW:p1"], 1 + 2 + 2);
});

test("bad shaping is a spec error", () => {
  const v = validateSpec(spec({rate: "fast", burst: 0}));
  assert.deepEqual(v.errors.map(e => e.path).sort(), ["$.links[0][3].shape.burst", "$.links[0][3].shape.limit", "$.links[0][3].shape.rate"]);
});
