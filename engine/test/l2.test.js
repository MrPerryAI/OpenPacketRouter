import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {Network, ping} from "../src/index.js";

const spec = name => JSON.parse(fs.readFileSync(new URL(`../../validate/l2/${name}.json`, import.meta.url)));
const roles = (net, sw) => Object.fromEntries(Object.entries(net.stpReport()[sw].ports).map(([p, q]) => [p, q.role]));

test("STP: the lowest bridge priority wins root; one port blocks; nothing forwards until listening and learning are over", () => {
  const net = Network.fromSpec(spec("stp-triangle"));
  net.runTo(1);
  assert.equal(ping(net, "PC-A", "10.0.0.2").error, "timeout", "ports are still listening");
  net.runTo(12);
  const r = net.stpReport();
  assert.ok(Object.values(r).every(b => b.root === r["SW-CORE"].bridge), "everyone agrees SW-CORE is root");
  assert.deepEqual(roles(net, "SW-B"), {g1: "root", g2: "blocked", f1: "designated"});
  assert.equal(ping(net, "PC-A", "10.0.0.2").ok, true);
});

test("STP: a converged loop doesn't storm; the blocked port carries nothing", () => {
  const net = Network.fromSpec(spec("stp-triangle"));
  net.runTo(12); net.flushCaches();
  const before = net.snapshot();
  ping(net, "PC-A", "10.0.0.2"); net.settle(1);
  const d = net.diff(before);
  assert.equal(d["SW-B:g2>SW-A:g2"], undefined, "nothing leaves the blocked port");
  assert.ok(Object.values(d).every(n => n <= 2), "each frame crosses each cable at most once per direction");
});

test("STP: only the root originates hellos, every hello time; others relay on their designated ports", () => {
  const net = Network.fromSpec(spec("stp-triangle"));
  net.runTo(24); const before = net.snapshot(); net.runTo(32);
  const b = net.diff(before, "bpdus");
  assert.equal(b["SW-CORE:g1>SW-A:g1"], 4);              // 8 s / hello 2 s
  assert.equal(b["SW-A:g1>SW-CORE:g1"], undefined);      // root ports send none
  assert.equal(b["SW-B:g2>SW-A:g2"], undefined);         // blocked ports send none
  assert.equal(b["SW-A:g2>SW-B:g2"], 4);                 // relayed by the designated port
});

test("STP: losing the root port fails over to the blocked port after two forward delays", () => {
  const net = Network.fromSpec(spec("stp-triangle"));
  net.runTo(30); net.setLink("SW-CORE:g2", false);
  net.runTo(31);
  assert.deepEqual([net.stpReport()["SW-B"].rootPort, net.stpReport()["SW-B"].ports.g2.state], ["g2", "listening"]);
  net.runTo(30 + 2 * 4 + 0.5);
  assert.equal(net.stpReport()["SW-B"].ports.g2.state, "forwarding");
  assert.equal(ping(net, "PC-B", "10.0.0.3").ok, true);
});

test("STP: an indirect failure waits for max age before the backup path opens", () => {
  const net = Network.fromSpec(spec("stp-ring"));
  net.runTo(30); net.setLink("SW1:right", false);
  net.runTo(30 + 3);
  assert.equal(net.stpReport()["SW4"].ports.up.state, "blocking", "SW4 still believes the old path");
  net.runTo(30 + 6 + 2 * 4 + 1);
  assert.equal(net.stpReport()["SW4"].ports.up.state, "forwarding");
  assert.ok(net.trace.some(e => e.node === "SW4" && e.event === "stp-maxage"));
});

test("STP: port priority picks between parallel cables; a switch without STP passes BPDUs through", () => {
  const net = Network.fromSpec(spec("stp-ring"));
  net.runTo(12);
  assert.deepEqual(roles(net, "SW4"), {t1: "blocked", t2: "root", up: "blocked", f1: "designated"});
  const before = net.snapshot(); net.runTo(16);
  assert.ok(net.diff(before, "bpdus")["HUB:p2>SW3:left"] > 0, "the hub-like switch floods BPDUs");
});

test("VLANs: access ports keep VLANs apart; the trunk tags; a router on a stick routes between them", () => {
  const net = Network.fromSpec(spec("vlan-trunk"));
  let before = net.snapshot();
  assert.equal(ping(net, "STAFF-1", "10.10.0.12").ok, true);
  net.settle(1);
  assert.equal(net.diff(before)["SW1:f2>STUDENT-1:eth0"], undefined, "students don't hear staff ARP");
  assert.equal(net.diff(before, "tagged")["SW1:trunk>SW2:trunk#10"], 2);
  net.flushCaches(); before = net.snapshot();
  assert.equal(ping(net, "STAFF-2", "10.20.0.21").ok, true);
  net.settle(1);
  const t = net.diff(before, "tagged");
  assert.ok(t["R1:eth0>SW1:router#20"] > 0 && t["R1:eth0>SW1:router#10"] > 0, "the router sends on both VLANs over one cable");
  assert.equal(ping(net, "PC-WRONG", "10.10.0.1").error, "timeout", "a PC in the wrong VLAN can't reach its gateway");
});

test("VLANs: a native VLAN mismatch leaks untagged traffic between VLANs", () => {
  const net = Network.fromSpec(spec("vlan-native-mismatch"));
  assert.equal(ping(net, "PC-A", "10.0.0.2").ok, true, "VLAN 1 on SW1 reaches VLAN 99 on SW2");
  assert.equal(ping(net, "PC-A", "10.0.0.3").error, "timeout", "but not VLAN 1 on SW2");
  assert.equal(ping(net, "PC-D", "10.0.10.2").ok, true);
});

test("VLANs + STP: one tree for all VLANs; BPDUs are untagged", () => {
  const net = Network.fromSpec(spec("vlan-stp"));
  net.runTo(12);
  assert.equal(roles(net, "SW3").to2, "blocked");
  net.flushCaches(); const before = net.snapshot();
  assert.equal(ping(net, "STUDENT-3", "10.10.0.12").ok, true);
  net.settle(1);
  assert.equal(net.diff(before)["SW3:to2>SW2:to3"], undefined);
  const b = net.snapshot(); net.runTo(20);
  assert.ok(Object.keys(net.diff(b, "bpdus")).length > 0);
  assert.deepEqual(net.diff(b, "tagged"), {});
});

test("STP is deterministic", () => {
  const run = () => { const net = Network.fromSpec(spec("stp-ring")); net.runTo(20); net.setLink("SW1:right", false); net.runTo(40); return JSON.stringify([net.stpReport(), [...net.bpdus]]); };
  assert.equal(run(), run());
});
