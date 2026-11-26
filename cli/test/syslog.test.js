// service syslog: the command, the spec key, running-config, and show syslog.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createSession} from "../src/index.js";
import {engineBackend} from "../src/backends/engine.js";
import {ROOT} from "./helpers.js";

const lab = () => JSON.parse(fs.readFileSync(path.join(ROOT, "validate/services/syslog-lan.json"), "utf8"));

test("service syslog turns the receiver on and off; show syslog says what it has", () => {
  const b = engineBackend(lab()), s = createSession(b, "S", {mode: "config"});
  assert.match(createSession(b, "S", {mode: "priv"}).exec("show syslog").output, /not running/);
  s.exec("service syslog"); assert.equal(b.spec().nodes.find(n => n.name === "S").services.syslog, true);
  assert.match(createSession(b, "S", {mode: "priv"}).exec("show running-config").output, /\nservice syslog\n/);
  assert.match(createSession(b, "S", {mode: "priv"}).exec("show syslog").output, /No messages yet/);
  s.exec("no service syslog"); assert.equal(b.spec().nodes.find(n => n.name === "S").services, undefined);
  assert.match(s.exec("no service syslog").output, /not running/);
});
