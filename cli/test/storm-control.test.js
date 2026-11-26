// Storm control: the commands, show storm-control (text and | json), running-config and the spec they build.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createSession} from "../src/index.js";
import {engineBackend} from "../src/backends/engine.js";
import {ROOT} from "./helpers.js";

const spec = () => JSON.parse(fs.readFileSync(path.join(ROOT, "examples/storm-control/spec.json"), "utf8"));

test("storm-control commands build the spec and print in running-config", () => {
  const b = engineBackend(spec()), s = createSession(b, "SW1", {mode: "config"});
  s.exec("interface p2");
  assert.equal(s.exec("storm-control broadcast rate 1mbit burst 1500").output, "");
  assert.deepEqual(b.spec().nodes.find(n => n.name === "SW1").stormControl.p2, {broadcast: {rate: "1mbit", burst: 1500}});
  assert.match(createSession(b, "SW1", {mode: "priv"}).exec("show running-config").output, /^ storm-control broadcast rate 1mbit burst 1500$/m);
  s.exec("no storm-control broadcast");
  assert.equal(b.spec().nodes.find(n => n.name === "SW1").stormControl.p2, undefined);
  assert.match(s.exec("no storm-control broadcast").output, /%/);
  assert.match(s.exec("storm-control broadcast rate fast burst 10").output, /%/);
});
test("show storm-control: a table, and data with | json", () => {
  const b = engineBackend(spec()), sw = createSession(b, "SW1", {mode: "priv"});
  assert.match(sw.exec("show storm-control").output, /broadcast/);
  const rows = JSON.parse(sw.exec("show storm-control | json").output);
  assert.equal(rows.length, 1); assert.equal(rows[0].broadcast.burst, 400);
  assert.match(createSession(b, "A", {mode: "priv"}).exec("show storm-control").output, /%/);
});
