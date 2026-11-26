// service ntp: the command, the spec key, running-config, and show ntp.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createSession} from "../src/index.js";
import {engineBackend} from "../src/backends/engine.js";
import {ROOT} from "./helpers.js";

const lab = () => JSON.parse(fs.readFileSync(path.join(ROOT, "validate/services/syslog-lan.json"), "utf8"));

test("service ntp STRATUM turns the server on and off; show ntp says what it has", () => {
  const b = engineBackend(lab()), s = createSession(b, "S", {mode: "config"});
  assert.match(createSession(b, "S", {mode: "priv"}).exec("show ntp").output, /not running/);
  s.exec("service ntp 3"); assert.equal(b.spec().nodes.find(n => n.name === "S").services.ntp, 3);
  assert.match(createSession(b, "S", {mode: "priv"}).exec("show running-config").output, /\nservice ntp 3\n/);
  assert.match(createSession(b, "S", {mode: "priv"}).exec("show ntp").output, /stratum 3; 0 client queries/);
  assert.notEqual(s.exec("service ntp 16").ok, true);
  s.exec("no service ntp"); assert.equal(b.spec().nodes.find(n => n.name === "S").services, undefined);
  assert.match(s.exec("no service ntp").output, /not running/);
});
