// Port security: the commands, show port-security (text and | json), running-config, and the spec they build.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createSession} from "../src/index.js";
import {engineBackend} from "../src/backends/engine.js";
import {ROOT} from "./helpers.js";

const spec = () => JSON.parse(fs.readFileSync(path.join(ROOT, "examples/port-security/spec.json"), "utf8"));

test("port security commands build the spec and print in running-config", () => {
  const b = engineBackend(spec()), s = createSession(b, "SW1", {mode: "config"});
  s.exec("interface p2");
  assert.equal(s.exec("switchport port-security maximum 3").output, "");
  assert.equal(s.exec("switchport port-security violation shutdown").output, "");
  assert.deepEqual(b.spec().nodes.find(n => n.name === "SW1").portSecurity, {p1: {max: 1, violation: "restrict"}, p2: {max: 3, violation: "shutdown"}});
  assert.match(createSession(b, "SW1", {mode: "priv"}).exec("show running-config").output, /^ switchport port-security maximum 3$/m);
  s.exec("no switchport port-security");
  assert.equal(b.spec().nodes.find(n => n.name === "SW1").portSecurity.p2, undefined);
  assert.match(s.exec("switchport port-security violation protect").output, /%/);   // no limit set on p2 any more
});

test("show port-security: a table, and data with | json", () => {
  const b = engineBackend(spec()), sw = createSession(b, "SW1", {mode: "priv"});
  createSession(b, "A", {mode: "priv"}).exec("ping 10.0.0.3");
  assert.match(sw.exec("show port-security").output, /restrict/);
  const rows = JSON.parse(sw.exec("show port-security | json").output);
  assert.equal(rows.length, 1); assert.equal(rows[0].secured.length, 1); assert.equal(rows[0].violations, 0); assert.equal(rows[0].max, 1);
  assert.match(createSession(b, "A", {mode: "priv"}).exec("show port-security").output, /%/);
});
