// VLAN names: `vlan N` / `name`, the vlanNames spec key, show vlan and the running-config round trip.
import test from "node:test";
import assert from "node:assert/strict";
import {createSession} from "../src/index.js";
import {engineBackend} from "../src/backends/engine.js";

const spec = () => ({nodes: [{name: "SW", kind: "switch", vlans: {p1: {access: 10}}}, {name: "A", kind: "host", ifaces: {eth0: "10.0.0.1/24"}}], links: [["SW:p1", "A:eth0"]]});
const sess = (sp = spec()) => { const b = engineBackend(sp); const s = createSession(b, "SW"); s.exec("enable"); s.exec("configure terminal"); return {s, b}; };

test("vlan N / name labels a VLAN, shows in show vlan, and lands in the spec", () => {
  const {s, b} = sess();
  assert.doesNotMatch(s.exec("vlan 10").output, /%/);
  assert.doesNotMatch(s.exec("name sales").output, /%/);
  s.exec("end");
  assert.equal(s.exec("show vlan brief | json").json.vlans.find(v => v.vlan === 10).name, "sales");
  assert.match(s.exec("show running-config").output, /vlan 10\n name sales/);
  assert.deepEqual(b.spec().nodes.find(n => n.name === "SW").vlanNames, {10: "sales"});
});

test("no name / no vlan remove the label; name needs a selected VLAN", () => {
  const {s} = sess();
  assert.match(s.exec("name x").output, /%/, "name outside config-vlan is rejected");
  s.exec("vlan 20"); s.exec("name lab"); s.exec("no name"); s.exec("end");
  assert.ok(!/vlan 20/.test(s.exec("show running-config").output));
  s.exec("configure terminal"); s.exec("vlan 20"); s.exec("name lab"); s.exec("exit"); s.exec("no vlan 20"); s.exec("end");
  assert.ok(!/vlan 20/.test(s.exec("show running-config").output));
});

test("vlanNames in a spec is read back", () => {
  const sp = spec(); sp.nodes[0].vlanNames = {10: "sales"};
  const {s} = sess(sp);
  s.exec("end");
  assert.equal(s.exec("show vlan brief | json").json.vlans.find(v => v.vlan === 10).name, "sales");
});
