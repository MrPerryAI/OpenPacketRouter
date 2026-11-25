// Port mirroring: monitor session commands, show monitor, running-config round trip, the Linux rendering.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createSession} from "../src/index.js";
import {engineBackend} from "../src/backends/engine.js";
import {linuxCommands} from "../src/backends/linux.js";
import {ROOT} from "./helpers.js";

const lab = () => JSON.parse(fs.readFileSync(path.join(ROOT, "validate/span/span-lab.json"), "utf8"));
const blank = () => { const s = lab(); delete s.nodes.find(n => n.name === "SW").monitor; return s; };
const swSpec = b => b.spec().nodes.find(n => n.name === "SW");

test("monitor session commands build the spec's monitor key and undo it", () => {
  const b = engineBackend(blank()), s = createSession(b, "SW", {mode: "config"});
  assert.equal(s.exec("monitor session 1 destination interface p4").output, "");
  s.exec("monitor session 1 source interface p1"); s.exec("monitor session 1 source interface p2 rx"); s.exec("monitor session 1 source interface p3 tx");
  assert.deepEqual(swSpec(b).monitor, {1: {destination: "p4", sources: {p1: "both", p2: "rx", p3: "tx"}}});
  s.exec("no monitor session 1 source interface p2");
  assert.deepEqual(Object.keys(swSpec(b).monitor[1].sources), ["p1", "p3"]);
  s.exec("no monitor session 1");
  assert.equal(swSpec(b).monitor, undefined);
});

test("a destination cannot be a source, and unknown sessions or ports are refused", () => {
  const b = engineBackend(blank()), s = createSession(b, "SW", {mode: "config"});
  s.exec("monitor session 1 destination interface p4");
  assert.match(s.exec("monitor session 1 source interface p4").output, /%/);
  assert.match(s.exec("no monitor session 9").output, /%/);
  assert.match(s.exec("no monitor session 1 source interface p1").output, /%/);
  assert.match(createSession(b, "A", {mode: "config"}).exec("monitor session 1 destination interface eth0").output, /%/);
});

test("show monitor: table text, | json, empty hint", () => {
  const b = engineBackend(lab()), sw = createSession(b, "SW", {mode: "priv"});
  const text = sw.exec("show monitor").output;
  assert.match(text, /Session/); assert.match(text, /p4/); assert.match(text, /p1\(both\)/); assert.match(text, /p2\(rx\)/);
  assert.deepEqual(JSON.parse(sw.exec("show monitor | json").output)["2"], {destination: "p5", sources: {p3: "tx"}});
  assert.match(createSession(engineBackend(blank()), "SW", {mode: "priv"}).exec("show monitor").output, /No monitor sessions/);
});

test("running-config shows the sessions and replaying it on a blank switch gives the same spec", () => {
  const b = engineBackend(lab()), rc = createSession(b, "SW", {mode: "priv"}).exec("show running-config").output;
  assert.match(rc, /^monitor session 1 destination interface p4$/m);
  assert.match(rc, /^monitor session 1 source interface p2 rx$/m);
  const b2 = engineBackend(blank()), s = createSession(b2, "SW", {mode: "config"});
  for (const l of rc.split("\n").filter(l => l.startsWith("monitor session"))) assert.equal(s.exec(l).output, "", l);
  assert.deepEqual(swSpec(b2).monitor, swSpec(b).monitor);
});

test("Linux rendering: destination leaves the bridge, clsact + matchall mirred per direction", () => {
  const b = engineBackend(lab()), out = linuxCommands(b.getConfig("SW"), {kind: "switch", ports: b.ports("SW")});
  assert.ok(!out.includes("ip link set p4 master br0")); assert.ok(out.includes("ip link set p1 master br0"));
  assert.ok(out.includes("tc filter add dev p1 ingress matchall action mirred egress mirror dev p4"));
  assert.ok(out.includes("tc filter add dev p1 egress matchall action mirred egress mirror dev p4"));
  assert.ok(out.includes("tc filter add dev p2 ingress matchall action mirred egress mirror dev p4"));
  assert.ok(!out.some(c => c.startsWith("tc filter add dev p2 egress")));
  assert.ok(out.includes("tc filter add dev p3 egress matchall action mirred egress mirror dev p5"));
  assert.equal(out.filter(c => c === "tc qdisc add dev p1 clsact").length, 1);
});
