import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {Network, ping, traceroute} from "../src/index.js";
import {validateSpec, validateActions, runActions} from "../src/spec.js";

const spec = name => JSON.parse(fs.readFileSync(new URL(`../../validate/intervlan/${name}.json`, import.meta.url), "utf8"));

// R routes VLANs 10 and 20 over one trunk with subinterfaces eth0.10 / eth0.20
function roas() {
  const net = new Network();
  net.addRouter("R", {ifaces: {"eth0.10": "10.0.10.1/24", "eth0.20": "10.0.20.1/24"}});
  net.addSwitch("SW", {vlans: {up: {trunk: [10, 20]}, p1: {access: 10}, p2: {access: 20}}});
  net.addHost("A", {ifaces: {eth0: "10.0.10.11/24"}, gw: "10.0.10.1"});
  net.addHost("B", {ifaces: {eth0: "10.0.20.12/24"}, gw: "10.0.20.1"});
  net.link("R:eth0", "SW:up"); net.link("A:eth0", "SW:p1"); net.link("B:eth0", "SW:p2");
  return net;
}

test("router on a stick: subinterfaces route between VLANs over one cable", () => {
  const r = ping(roas(), "A", "10.0.20.12");
  assert.deepEqual([r.ok, r.from], [true, "10.0.20.12"]);
  const tr = traceroute(roas(), "A", "10.0.20.12");
  assert.deepEqual(tr.hops.map(h => h.from), ["10.0.10.1", "10.0.20.12"]);
});

test("router on a stick: frames on the trunk are tagged with the subinterface's VLAN, and share the parent's MAC", () => {
  const net = roas(); const tags = [];
  const sw = net.node("SW"); const o = sw.receive.bind(sw);
  sw.receive = (i, f) => { if (i === "up") tags.push([f.vlan, f.src]); o(i, f); };
  ping(net, "A", "10.0.20.12"); net.settle();
  const r = net.node("R");
  assert.ok(tags.some(([v]) => v === 10) && tags.some(([v]) => v === 20));
  assert.ok(tags.every(([v]) => v === 10 || v === 20));
  assert.ok(tags.every(([, m]) => m === r.ifaces.eth0.mac));
  assert.equal(r.ifaces["eth0.10"].mac, r.ifaces.eth0.mac);
});

test("router on a stick: a tagged frame for a VLAN with no subinterface is dropped", () => {
  const net = roas();
  net.node("R").receive("eth0", {src: "02:00:00:00:00:99", dst: "ff:ff:ff:ff:ff:ff", vlan: 30, type: "arp",
    arp: {op: "request", sha: "02:00:00:00:00:99", spa: "10.0.10.99", tha: "00:00:00:00:00:00", tpa: "10.0.10.1"}});
  net.settle();
  assert.ok(net.trace.some(e => e.node === "R" && e.event === "vlan-drop"));
  assert.equal(net.counters.get("R:eth0>SW:up"), undefined);
});

// SW is a Layer 3 switch: SVIs vlan10 / vlan20 route between its own access ports
function l3() {
  const net = new Network();
  net.addSwitch("SW", {vlans: {p1: {access: 10}, p2: {access: 20}}, ifaces: {vlan10: "10.0.10.1/24", vlan20: "10.0.20.1/24"}});
  net.addHost("A", {ifaces: {eth0: "10.0.10.11/24"}, gw: "10.0.10.1"});
  net.addHost("B", {ifaces: {eth0: "10.0.20.12/24"}, gw: "10.0.20.1"});
  net.link("A:eth0", "SW:p1"); net.link("B:eth0", "SW:p2");
  return net;
}

test("Layer 3 switch: SVIs route between VLANs; the switch answers pings and can ping", () => {
  assert.equal(ping(l3(), "A", "10.0.20.12").ok, true);
  assert.deepEqual(traceroute(l3(), "A", "10.0.20.12").hops.map(h => h.from), ["10.0.10.1", "10.0.20.12"]);
  assert.equal(ping(l3(), "B", "10.0.10.1").ok, true);
  assert.equal(ping(l3(), "SW", "10.0.10.11").ok, true);
  const net = l3(); ping(net, "A", "10.0.20.12"); net.settle();
  // only the two access cables carry anything: routing happens inside the switch
  assert.deepEqual(Object.keys(net.diff(new Map())).sort(), ["A:eth0>SW:p1", "B:eth0>SW:p2", "SW:p1>A:eth0", "SW:p2>B:eth0"]);
});

test("Layer 3 switch: an unknown host in a VLAN gets host unreachable after 3 ARP tries", () => {
  const net = l3(); const r = ping(net, "A", "10.0.20.99", {timeout: 5});
  assert.deepEqual([r.ok, r.from, r.error], [false, "10.0.10.1", "host unreachable"]);
  assert.equal(net.counters.get("SW:p2>B:eth0"), 3);
});

test("spec: subinterfaces and SVIs validate; misuse is reported", () => {
  for (const n of ["roas", "svi"]) {
    const v = validateSpec(spec(n)); assert.deepEqual([v.errors, v.warnings], [[], []], n);
    assert.equal(validateActions(spec(n + ".actions"), spec(n)).ok, true);
  }
  const bad = {nodes: [
    {name: "R", kind: "router", ifaces: {"eth0.10": "10.0.10.1/24", "eth0.5000": "10.0.50.1/24", "eth0.x": "10.0.60.1/24"}},
    {name: "SW", kind: "switch", vlans: {p1: {access: 10}}, ifaces: {vlan10: "10.0.10.2/24", vlan77: "10.0.77.1/24", eth5: "10.5.0.1/24"}},
    {name: "P", kind: "switch", ifaces: {vlan10: "10.0.10.3/24"}},
    {name: "Q", kind: "switch", gw: "10.0.0.1"}],
    links: [["R:eth0.10", "SW:p1"], ["R:eth0", "SW:vlan10"]]};
  const msgs = validateSpec(bad);
  const all = [...msgs.errors, ...msgs.warnings].map(e => `${e.path}: ${e.message}`).join("\n");
  assert.match(all, /eth0\.5000: .*VLAN 5000 is not 1-4094/);
  assert.match(all, /eth0\.x: .*parent\.vid/);
  assert.match(all, /vlan77: .*no port carries VLAN 77/);
  assert.match(all, /eth5: .*SVIs named vlanN/);
  assert.match(all, /nodes\[2\]\.ifaces\.vlan10: .*VLAN-aware/);
  assert.match(all, /nodes\[3\]\.gw: .*needs SVIs/);
  assert.match(all, /R:eth0\.10 is a virtual interface .*cable eth0/);
  assert.match(all, /SW:vlan10 is a virtual interface \(an SVI\)/);
  assert.equal(validateSpec({nodes: bad.nodes.slice(0, 1), links: [["R:eth0", "R:eth0.10"]]}).errors.length > 0, true);
  const pings = validateActions([{do: "ping", src: "Q", dst: "10.0.0.1"}], bad);
  assert.match(pings.errors[0].message, /switch with no IP interfaces/);
});

test("spec: the inter-VLAN validation networks give the expected results in the engine", () => {
  const r = runActions(spec("roas"), spec("roas.actions")).map(e => e.result);
  assert.deepEqual(r.map(x => x.ok ?? x.reached), [true, true, true, true, true, true, false, false, false]);
  assert.equal(r[6].error, "net unreachable"); assert.equal(r[7].error, "host unreachable"); assert.equal(r[8].error, "timeout");
  const s = runActions(spec("svi"), spec("svi.actions")).map(e => e.result);
  assert.deepEqual(s.map(x => x.ok ?? x.reached), [true, true, true, true, true, true, true, true, false, false]);
});
