// MAC address table aging: the aging-time command, show mac address-table with ages, and the Linux rendering.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createSession} from "../src/index.js";
import {engineBackend} from "../src/backends/engine.js";
import {linuxCommands} from "../src/backends/linux.js";
import {ROOT} from "./helpers.js";

const spec = () => JSON.parse(fs.readFileSync(path.join(ROOT, "examples/mac-aging/spec.json"), "utf8"));

test("mac address-table aging-time: set, show in running-config, change the spec, undo", () => {
  const b = engineBackend(spec()), s = createSession(b, "SW2", {mode: "config"});
  assert.equal(s.exec("mac address-table aging-time 30").output, "");
  assert.match(createSession(b, "SW2", {mode: "priv"}).exec("show running-config").output, /^mac address-table aging-time 30$/m);
  assert.equal(b.spec().nodes.find(n => n.name === "SW2").agingTime, 30);
  s.exec("no mac address-table aging-time");
  assert.equal(b.spec().nodes.find(n => n.name === "SW2").agingTime, undefined);
  assert.match(s.exec("mac address-table aging-time 0").output, /%/);
});

test("show mac address-table lists ages; | json is data; hosts have no such command", () => {
  const b = engineBackend(spec()), sw = createSession(b, "SW1", {mode: "priv"});
  createSession(b, "A", {mode: "priv"}).exec("ping 10.0.0.3");
  const text = sw.exec("show mac address-table").output;
  assert.match(text, /Age/); assert.match(text, /2 entries/);
  const rows = JSON.parse(sw.exec("show mac address-table | json").output);
  assert.equal(rows.length, 2); assert.ok(rows.every(r => typeof r.age === "number" && r.port));
  assert.match(createSession(b, "A", {mode: "config"}).exec("mac address-table aging-time 30").output, /%/);
});

test("linux rendering sets the bridge's ageing_time in centiseconds", () => {
  const b = engineBackend(spec());
  const out = linuxCommands(b.getConfig("SW1"), {kind: "switch", ports: b.ports("SW1")});
  assert.match(out[0], /^ip link add br0 type bridge stp_state 0 ageing_time 500/);
});
