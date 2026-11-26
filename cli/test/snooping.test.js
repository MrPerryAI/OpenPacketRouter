import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {createSession} from "../src/index.js";
import {engineBackend} from "../src/backends/engine.js";
import {ROOT} from "./helpers.js";

const spec = () => JSON.parse(fs.readFileSync(`${ROOT}/validate/dhcp-snooping/snoop.json`, "utf8"));

test("show ip dhcp snooping: trusted ports and drops, with a JSON form; round-trips through the running config", () => {
  const s = createSession(engineBackend(spec()), "SW");
  s.exec("enable");
  assert.match(s.exec("show ip dhcp snooping").output, /Trusted ports: p1/);
  assert.deepEqual(JSON.parse(s.exec("show ip dhcp snooping | json").output), {enabled: true, trusted: ["p1"], dropped: {}});
  const cfg = s.exec("show running-config").output;
  assert.match(cfg, /^ip dhcp snooping$/m); assert.match(cfg, /interface p1\n ip dhcp snooping trust/);
});

test("configure: snooping and trust change the spec; trust needs snooping on", () => {
  const b = engineBackend({...spec(), nodes: spec().nodes.map(n => { if (n.name === "SW") { const {dhcpSnooping, ...r} = n; return r; } return n; })});
  const s = createSession(b, "SW");
  for (const c of ["enable", "configure terminal", "interface p1"]) s.exec(c);
  assert.match(s.exec("ip dhcp snooping trust").output, /Turn DHCP snooping on first/);
  s.exec("exit"); s.exec("ip dhcp snooping"); s.exec("interface p1"); s.exec("ip dhcp snooping trust");
  assert.deepEqual(b.spec().nodes.find(n => n.name === "SW").dhcpSnooping, {trusted: ["p1"]});
  s.exec("no ip dhcp snooping trust");
  assert.deepEqual(b.spec().nodes.find(n => n.name === "SW").dhcpSnooping, {trusted: []});
});
