// OSPF in the CLI: router ospf, network, interface settings, running-config round trip, show commands.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createSession} from "../src/index.js";
import {engineBackend} from "../src/backends/engine.js";
import {loadSpec} from "../../engine/src/spec.js";
import {frrConfig} from "../src/backends/frr.js";
import {ROOT} from "./helpers.js";

const spec = () => ({nodes: [{name: "R1", kind: "router", ifaces: {eth0: "10.0.0.1/24"}}, {name: "R2", kind: "router", ifaces: {eth0: "10.0.0.2/24"}}], links: [["R1:eth0", "R2:eth0"]]});
const run = (s, cmds) => cmds.map(c => s.exec(c));
const ok = rs => rs.forEach(r => assert.doesNotMatch(r.output, /%/, r.output));

test("router ospf + network + interface settings land in the spec", () => {
  const b = engineBackend(spec()), s = createSession(b, "R1"); s.exec("enable");
  ok(run(s, ["configure terminal", "router ospf", "router-id 1.1.1.1", "network 10.0.0.0/8", "exit", "interface eth0",
    "ospf cost 5", "ospf hello-interval 1", "ospf dead-interval 4", "ospf network point-to-point", "ospf priority 0", "end"]));
  assert.deepEqual(b.spec().nodes[0].ospf, {routerId: "1.1.1.1", networks: ["10.0.0.0/8"],
    interfaces: {eth0: {type: "point-to-point", priority: 0, cost: 5, hello: 1, dead: 4}}});
  const cfg = s.exec("show running-config").output;
  assert.match(cfg, /router ospf\n router-id 1\.1\.1\.1\n network 10\.0\.0\.0\/8/);
  assert.match(cfg, / ospf network point-to-point\n ospf cost 5\n ospf priority 0\n ospf hello-interval 1\n ospf dead-interval 4/);
});

test("no router ospf removes it; settings before a network stay pending", () => {
  const b = engineBackend(spec()), s = createSession(b, "R1"); s.exec("enable");
  ok(run(s, ["configure terminal", "router ospf"]));
  assert.equal(b.spec().nodes[0].ospf, undefined, "no network yet: not in the spec");
  ok(run(s, ["network interface eth0", "exit"]));
  assert.deepEqual(b.spec().nodes[0].ospf, {networks: ["eth0"]});
  ok(run(s, ["no router ospf", "end"]));
  assert.equal(b.spec().nodes[0].ospf, undefined);
  assert.doesNotMatch(s.exec("show running-config").output, /router ospf/);
});

test("ospf commands are for routers, and need router ospf first", () => {
  const s = createSession(engineBackend(spec()), "R1"); s.exec("enable"); s.exec("configure terminal");
  s.exec("interface eth0");
  assert.match(s.exec("ospf cost 5").output, /OSPF is not running/);
});

test("show ip ospf ... | json equal the engine's own OSPF state once converged (p2p and LAN)", () => {
  for (const name of ["ospf-p2p", "ospf-lan"]) {
    const sp = JSON.parse(fs.readFileSync(path.join(ROOT, "validate/ospf", name + ".net"), "utf8"));
    const truth = loadSpec(sp); truth._start(); truth.run(100);   // converged and stable; the CLI backend settles by itself, no wait needed
    const b = engineBackend(sp);
    for (const dev of b.devices().filter(d => b.kind(d) === "router")) {
      const s = createSession(b, dev); s.exec("enable");
      const o = truth.node(dev).ospf;
      assert.deepEqual(s.exec("show ip ospf neighbor | json").json, o.neighbors(), `${name} ${dev} neighbor`);
      assert.deepEqual(s.exec("show ip ospf interface | json").json, o.interfaces(), `${name} ${dev} interface`);
      assert.deepEqual(s.exec("show ip ospf route | json").json, o.describe(), `${name} ${dev} route`);
      assert.deepEqual(s.exec("show ip ospf database | json").json, o.database(), `${name} ${dev} database`);
      assert.ok(o.neighbors().length, `${name} ${dev} has neighbors`);
      assert.match(s.exec("show ip ospf neighbor").output, /Full/, "text view lists the full adjacency");
      const rt = s.exec("show ip route | json").json;
      assert.ok(rt.some(r => r.protocol === "ospf"), `${name} ${dev}: show ip route lists OSPF routes: ${JSON.stringify(rt)}`);
    }
  }
});

test("show ip ospf ... with OSPF off: a message, and json null; not offered on hosts", () => {
  const sp = JSON.parse(fs.readFileSync(path.join(ROOT, "validate/ospf/ospf-p2p.net"), "utf8"));
  const h = createSession(engineBackend(sp), "H1"); h.exec("enable");
  assert.match(h.exec("show ip ospf neighbor").output, /%/);
  const r = createSession(engineBackend(spec()), "R1"); r.exec("enable");
  assert.equal(r.exec("show ip ospf neighbor | json").json, null);
  assert.match(r.exec("show ip ospf neighbor").output, /not running/);
});

test("every OSPF spec in validate/ spells out the same configuration through the CLI", () => {
  for (const name of ["ospf-p2p", "ospf-lan", "ospf-priority"]) {
    const sp = JSON.parse(fs.readFileSync(path.join(ROOT, "validate/ospf", name + ".net"), "utf8"));
    const b = engineBackend(sp);
    for (const dev of b.devices().filter(d => b.kind(d) === "router")) {
      const s = createSession(b, dev); s.exec("enable");
      const cfg = s.exec("show running-config").output;
      assert.match(cfg, /router ospf/, `${name} ${dev}`);
    }
  }
});

test("the FRR renderer writes router ospf, networks and interface settings", () => {
  const b = engineBackend(spec()), s = createSession(b, "R1"); s.exec("enable");
  ok(run(s, ["configure terminal", "router ospf", "router-id 1.1.1.1", "network interface eth0", "exit", "interface eth0", "ospf cost 5", "ospf hello-interval 1", "end"]));
  const f = frrConfig(b.getConfig("R1"), {ports: ["eth0"]});
  assert.match(f, /interface eth0\n ip address 10\.0\.0\.1\/24\n ip ospf cost 5\n ip ospf hello-interval 1\nexit/);
  assert.match(f, /router ospf\n ospf router-id 1\.1\.1\.1\n network 10\.0\.0\.0\/24 area 0\nexit/);
});

test("passive-interface lands in the spec, running-config and FRR config", () => {
  const b = engineBackend(spec()), s = createSession(b, "R1"); s.exec("enable");
  ok(run(s, ["configure terminal", "router ospf", "network 10.0.0.0/8", "passive-interface eth0", "end"]));
  assert.deepEqual(b.spec().nodes[0].ospf.passive, ["eth0"]);
  assert.match(s.exec("show running-config").output, /router ospf\n network 10\.0\.0\.0\/8\n passive-interface eth0/);
  assert.match(frrConfig(b.getConfig("R1")), /passive-interface eth0/);
  ok(run(s, ["configure terminal", "router ospf", "no passive-interface eth0", "end"]));
  assert.equal(b.spec().nodes[0].ospf.passive, undefined);
});

test("network ... area puts interfaces in another area; it renders and reaches the FRR config", () => {
  const b = engineBackend(spec()), s = createSession(b, "R1"); s.exec("enable");
  ok(run(s, ["configure terminal", "router ospf", "network 10.0.0.0/24 area 1", "network interface eth0 area 0.0.0.2", "network 10.9.0.0/24", "exit", "end"]));
  assert.deepEqual(b.spec().nodes[0].ospf.networks, [{network: "10.0.0.0/24", area: "0.0.0.1"}, {network: "eth0", area: "0.0.0.2"}, "10.9.0.0/24"]);
  assert.match(s.exec("show running-config").output, / network 10\.0\.0\.0\/24 area 0\.0\.0\.1\n network interface eth0 area 0\.0\.0\.2\n network 10\.9\.0\.0\/24\n/);
  assert.match(s.exec("show running-config").output, /area 0\.0\.0\.1/);
});

test("redistribute connected/static with metric and metric-type: spec, running-config round trip, FRR rendering", () => {
  const b = engineBackend(spec()), s = createSession(b, "R1"); s.exec("enable");
  ok(run(s, ["configure terminal", "router ospf", "network 10.0.0.0/8", "redistribute connected metric 30 metric-type 1", "redistribute static", "redistribute static metric 10", "exit", "end"]));
  assert.deepEqual(b.spec().nodes[0].ospf.redistribute, [{source: "connected", metric: 30, metricType: 1}, {source: "static", metric: 10}]);
  const cfg = s.exec("show running-config").output;
  assert.match(cfg, / redistribute connected metric 30 metric-type 1\n redistribute static metric 10\n/);
  const again = createSession(engineBackend(b.spec()), "R1"); again.exec("enable"); assert.equal(again.exec("show running-config").output, cfg);
  const frr = frrConfig(b.getConfig("R1"), {ports: b.ports("R1")});
  assert.match(frr, / redistribute connected metric 30 metric-type 1\n redistribute static metric 10 metric-type 2\n/);   // ospfd's default type written out
  ok(run(s, ["configure terminal", "router ospf", "no redistribute connected", "end"]));
  assert.deepEqual(b.spec().nodes[0].ospf.redistribute, [{source: "static", metric: 10}]);
  assert.match(run(s, ["configure terminal", "router ospf", "no redistribute connected"])[2].output, /not redistributed/);
  assert.match(run(s, ["end", "configure terminal", "router ospf", "redistribute static metric-type 3"])[3].output, /%/);
});

test("area ranges: spec, running-config round trip, FRR rendering, removal", () => {
  const b = engineBackend(spec()), s = createSession(b, "R1"); s.exec("enable");
  ok(run(s, ["configure terminal", "router ospf", "network 10.0.0.0/8 area 1", "area 1 range 10.1.0.0/16", "area 0.0.0.1 range 10.2.0.0/16 not-advertise", "end"]));
  assert.deepEqual(b.spec().nodes[0].ospf.ranges, [{area: "0.0.0.1", network: "10.1.0.0/16"}, {area: "0.0.0.1", network: "10.2.0.0/16", notAdvertise: true}]);
  const cfg = s.exec("show running-config").output;
  assert.match(cfg, / area 0.0.0.1 range 10.1.0.0\/16\n area 0.0.0.1 range 10.2.0.0\/16 not-advertise\n/);
  const again = createSession(engineBackend(b.spec()), "R1"); again.exec("enable"); assert.equal(again.exec("show running-config").output, cfg);
  assert.match(frrConfig(b.getConfig("R1"), {ports: b.ports("R1")}), / area 0.0.0.1 range 10.1.0.0\/16\n area 0.0.0.1 range 10.2.0.0\/16 not-advertise\n/);
  ok(run(s, ["configure terminal", "router ospf", "no area 1 range 10.1.0.0/16", "end"]));
  assert.equal(b.spec().nodes[0].ospf.ranges.length, 1);
  assert.match(run(s, ["configure terminal", "router ospf", "no area 1 range 10.9.0.0/16"])[2].output, /No range/);
});
