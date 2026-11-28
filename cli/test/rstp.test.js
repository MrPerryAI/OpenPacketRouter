import test from "node:test";
import assert from "node:assert/strict";
import {createSession} from "../src/index.js";
import {engineBackend} from "../src/backends/engine.js";
import {linuxCommands} from "../src/backends/linux.js";
import fs from "node:fs";
import path from "node:path";
import {ROOT} from "./helpers.js";

const load = lab => JSON.parse(fs.readFileSync(path.join(ROOT, "examples", lab, "spec.json"), "utf8"));
const sess = (lab, dev) => createSession(engineBackend(load(lab)), dev);

test("spanning-tree mode rstp / portfast show up in running-config, and round-trip through the spec", () => {
  const b = engineBackend(load("loop-with-stp")), sw = b.spec().nodes.find(n => n.kind === "switch").name;
  const s = createSession(b, sw);
  for (const c of ["enable", "configure terminal", "spanning-tree mode rstp", "interface p1", "spanning-tree portfast", "end"]) {
    const o = s.exec(c).output; assert.ok(!/^%/m.test(o), `${c}: ${o}`);
  }
  const cfg = s.exec("show running-config").output;
  assert.match(cfg, /^spanning-tree mode rstp$/m);
  assert.match(cfg, /^ spanning-tree portfast$/m);
  const n = b.spec().nodes.find(x => x.name === sw);
  assert.equal(n.stp.mode, "rstp"); assert.deepEqual(n.stp.edge, {p1: true});
  s.exec("configure terminal"); s.exec("no spanning-tree mode"); s.exec("end");
  assert.equal(b.spec().nodes.find(x => x.name === sw).stp.mode, undefined);
});

test("show spanning-tree on an RSTP switch names the protocol, the roles and edge ports; json has the mode", () => {
  const s = sess("rstp-fast-failover", "SW3"); s.exec("enable");
  const t = s.exec("show spanning-tree").output;
  assert.match(t, /^Protocol rapid spanning tree \(RSTP\)/m);
  assert.match(t, /alternate/); assert.match(t, /Edge/);
  const j = JSON.parse(s.exec("show spanning-tree | json").output);
  assert.equal(j.mode, "rstp"); assert.equal(j.ports.p1.role === "root" || j.ports.p2.role === "root", true);
});

test("portfast needs spanning tree to be on", () => {
  const s = sess("loop-no-stp", "SW1"); s.exec("enable"); s.exec("configure terminal"); s.exec("interface p1");
  assert.match(s.exec("spanning-tree portfast").output, /^% Turn spanning tree on first/);
});

test("Linux rendering of an RSTP switch uses stp_state 2 and mstpctl", () => {
  const b = engineBackend(load("rstp-fast-failover")), out = linuxCommands(b.getConfig("SW2"), {kind: "switch", ports: b.ports("SW2")});
  assert.match(out[0], /^ip link add br0 type bridge stp_state 2/);
  assert.ok(out.includes("mstpctl setforcevers br0 rstp"));
  assert.ok(out.some(l => /^mstpctl setportpathcost br0 p1 20000$/.test(l)));
  assert.ok(out.includes("mstpctl setportadminedge br0 p3 yes"));
});

test("spanning-tree bpdu-guard / root-guard: running-config, spec round trip, show json, Linux flags, and the rstp refusal", () => {
  const b = engineBackend(load("stp-guards")), s = createSession(b, "SW2");
  for (const c of ["enable", "configure terminal", "interface p1", "spanning-tree bpdu-guard", "spanning-tree root-guard", "end"]) assert.ok(!/^%/m.test(s.exec(c).output), c);
  assert.match(s.exec("show running-config").output, /^ spanning-tree bpdu-guard\n spanning-tree root-guard$/m);
  const n = b.spec().nodes.find(x => x.name === "SW2");
  assert.deepEqual(n.stp.bpduGuard, {p1: true}); assert.deepEqual(n.stp.rootGuard, {p1: true});
  assert.deepEqual(JSON.parse(s.exec("show interfaces p1 | json").output).stp, {cost: null, portPriority: null, bpduGuard: true, rootGuard: true});
  const cmds = linuxCommands(b.getConfig("SW2"), {kind: "switch", ports: ["p1", "p2"]}).join("\n");
  assert.match(cmds, /ip link set p1 type bridge_slave cost \d+ guard on root_block on/);
  s.exec("configure terminal"); s.exec("interface p1"); s.exec("no spanning-tree bpdu-guard"); s.exec("no spanning-tree root-guard"); s.exec("end");
  assert.equal(b.spec().nodes.find(x => x.name === "SW2").stp.bpduGuard, undefined);
  const r = sess("rstp-fast-failover", "SW1"); for (const c of ["enable", "configure terminal", "interface p1"]) r.exec(c);
  assert.match(r.exec("spanning-tree bpdu-guard").output, /^% bpdu-guard is for classic/);
});
