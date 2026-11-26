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

test("non-IP frames have a size too (spanning tree, LACP, LLDP, IPv6) and never crash the shaper", () => {
  assert.equal(frameBytes({type: "bpdu", bpdu: {root: "x"}}), 52);                  // 14 + 3 LLC + 35
  assert.equal(frameBytes({type: "bpdu", bpdu: {version: 2}}), 53);
  assert.equal(frameBytes({type: "bpdu", bpdu: {tcn: true}}), 21);
  assert.equal(frameBytes({type: "bpdu", vlan: 5, bpdu: {tcn: true}}), 25);
  assert.equal(frameBytes({type: "lacpdu", lacpdu: {}}), 124);
  assert.equal(frameBytes({type: "lldp", lldp: {portDescr: "eth0", sysName: "SW", sysDescr: "d"}}), 14 + 9 + 9 + 4 + 6 + 4 + 3 + 8 + 2);
  assert.equal(frameBytes({type: "ipv6", ip6: {proto: "icmp6", icmp: {type: 135}}}), 14 + 40 + 32);
  assert.equal(frameBytes({type: "ipv6", ip6: {proto: "icmp6", icmp: {type: 128, size: 56}}}), 14 + 40 + 8 + 56);
});

test("spanning-tree BPDUs cross a shaped cable, and a queue one byte too small drops each 52-byte BPDU", () => {
  const sp = limit => ({nodes: [{name: "S1", kind: "switch", stp: {mac: "02:bb:00:00:00:01", hello: 1, maxAge: 6, forwardDelay: 4}},
    {name: "S2", kind: "switch", stp: {mac: "02:bb:00:00:00:02", hello: 1, maxAge: 6, forwardDelay: 4}}],
    links: [["S1:p1", "S2:p1", 1, {shape: {rate: "1mbit", burst: 3000, limit}}]]});
  const acts = [{do: "wait", seconds: 5}];
  const [ok] = runActions(sp(4000), acts);
  assert.ok(ok.frames["S1:p1>S2:p1"] >= 4); assert.deepEqual(ok.drops ?? {}, {});
  const [tight] = runActions(sp(51), acts);
  assert.equal(tight.frames["S1:p1>S2:p1"] ?? 0, 0); assert.ok(tight.drops["S1:p1"] >= 4);
  const [fits] = runActions(sp(52), acts);
  assert.ok(fits.frames["S1:p1>S2:p1"] >= 4);
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
