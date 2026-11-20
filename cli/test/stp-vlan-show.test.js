// show spanning-tree timers and interface, show vlan id.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createSession} from "../src/index.js";
import {engineBackend} from "../src/backends/engine.js";
import {ROOT} from "./helpers.js";

const sess = (lab, dev) => { const s = createSession(engineBackend(JSON.parse(fs.readFileSync(path.join(ROOT, "examples", lab, "spec.json"), "utf8"))), dev); s.exec("enable"); return s; };

test("show spanning-tree: timers, and one port in detail", () => {
  const s = sess("loop-with-stp", "SW1");
  const j = s.exec("show spanning-tree | json").json;
  assert.deepEqual(j.timers, {helloTime: 1, maxAge: 6, forwardDelay: 4, priority: 32768});
  assert.match(s.exec("show spanning-tree").output, /hello 1 s, max age 6 s, forward delay 4 s/);
  const p = s.exec("show spanning-tree interface p1 | json").json;
  assert.deepEqual([p.name, p.role, p.state], ["p1", "designated", "forwarding"]);
  assert.match(s.exec("show spanning-tree interface zz").output, /^% No interface zz on SW1/);
});

test("show vlan id: access ports, trunks and the SVI", () => {
  const s = sess("l3-switch", "SW1");
  assert.deepEqual(s.exec("show vlan id 10 | json").json, {vlan: 10, name: "VLAN0010", accessPorts: ["p1"], trunkPorts: [{port: "tr0", native: false}], svi: "vlan10", address: "10.0.10.1/24", link: "up"});
  assert.match(s.exec("show vlan id 99").output, /^VLAN 99 has no ports/);
  const plain = sess("vlans", "SW1").exec("show vlan id 10 | json").json;
  assert.ok(!("svi" in plain) && plain.accessPorts.length > 0);
});
