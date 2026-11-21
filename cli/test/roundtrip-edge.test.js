// Hand-written edge cases for the show running-config round trip.
import test from "node:test";
import assert from "node:assert/strict";
import {createSession} from "../src/index.js";
import {engineBackend} from "../src/backends/engine.js";
import {blankDevice} from "./helpers.js";

const spec = {
  version: 1, name: "edge",
  nodes: [
    {name: "SW1", kind: "switch", vlans: {p1: {access: 10}, t: {trunk: [10, 20, 30], native: 20}}},
    {name: "SW2", kind: "switch", vlans: {t: {trunk: [10, 20, 30], native: 20}, p1: {access: 10}}},
    {name: "H1", kind: "host", ifaces: {eth0: "10.0.0.1/24"}},
    {name: "H2", kind: "host", ifaces: {eth0: "10.0.0.2/24"}},
  ],
  links: [["H1:eth0", "SW1:p1"], ["H2:eth0", "SW2:p1"],
    ["SW1:t", "SW2:t", null, {shape: {rate: "1mbit", burst: 3000, limit: 4000}, shapeBack: {rate: "2mbit", burst: 3000, limit: 4000}}]],
};

for (const device of ["SW1", "SW2", "H1"]) {
  test(`edge round trip: ${device}`, () => {
    const text = createSession(engineBackend(spec), device, {mode: "priv"}).exec("show running-config").output;
    const b = engineBackend(blankDevice(spec, device));
    const r = createSession(b, "NEW", {mode: "config"});
    for (const line of text.split("\n")) {
      if (/^\s*(!|end$)/.test(line)) continue;
      const out = r.exec(line.trim());
      assert.ok(!out.output.startsWith("%") && !out.output.includes("\n%"), `"${line.trim()}" -> ${out.output}`);
    }
    const back = b.spec();
    assert.deepEqual(back.nodes.find(n => n.name === device), spec.nodes.find(n => n.name === device), text);
    assert.deepEqual(back.links, spec.links, text);
  });
}

test("edge round trip: shutdown and hostname rename made through the CLI", () => {
  const b = engineBackend(spec);
  const s = createSession(b, "SW1", {mode: "config"});
  for (const l of ["interface p1", "shutdown", "exit", "hostname CORE"]) {
    const o = s.exec(l).output; assert.ok(!o.startsWith("%"), `${l} -> ${o}`);
  }
  const text = createSession(b, "CORE", {mode: "priv"}).exec("show running-config").output;
  assert.ok(text.startsWith("hostname CORE"), text);
  assert.match(text, /interface p1[\s\S]*? shutdown/, text);
  const b2 = engineBackend(blankDevice(b.spec(), "CORE"));
  const r = createSession(b2, "NEW", {mode: "config"});
  for (const line of text.split("\n")) {
    if (/^\s*(!|end$)/.test(line)) continue;
    const o = r.exec(line.trim()).output;
    assert.ok(!o.startsWith("%") && !o.includes("\n%"), `"${line.trim()}" -> ${o}`);
  }
  assert.deepEqual(b2.spec().nodes.find(n => n.name === "CORE"), b.spec().nodes.find(n => n.name === "CORE"), text);
});
