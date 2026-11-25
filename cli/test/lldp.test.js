// LLDP commands: configure, show lldp [neighbors] with | json, running-config round trip, Linux rendering.
import test from "node:test";
import assert from "node:assert/strict";
import {createSession} from "../src/index.js";
import {engineBackend} from "../src/backends/engine.js";
import {linuxCommands} from "../src/backends/linux.js";

const spec = () => ({format: "openpacketrouter.spec/1", name: "lldp-cli", nodes: [
  {name: "R1", kind: "router", ifaces: {eth0: "10.0.0.1/24"}, lldp: {}},
  {name: "H1", kind: "host", ifaces: {eth0: "10.0.0.2/24"}, lldp: {txInterval: 10, holdMultiplier: 3}},
  {name: "SW", kind: "switch"}], links: [["R1:eth0", "H1:eth0"]]});

const run = (backend, device, ...cmds) => { const s = createSession(backend, device, {mode: "priv"}); return cmds.map(c => s.exec(c.replace(/^(conf t)$/, "configure terminal"))); };

test("show lldp neighbors lists the neighbor, with a JSON form", () => {
  const b = engineBackend(spec());
  const [text, js] = run(b, "R1", "show lldp neighbors", "show lldp neighbors | json");
  assert.match(text.output, /H1/);
  assert.equal(js.json[0].sysName, "H1"); assert.equal(js.json[0].iface, "eth0"); assert.equal(js.json[0].ttl, 30);
  const [, sh] = run(b, "H1", "show lldp", "show lldp | json");
  assert.deepEqual([sh.json.enabled, sh.json.txInterval, sh.json.holdMultiplier, sh.json.ttl, sh.json.neighbors], [true, 10, 3, 30, 1]);
});

test("configure: lldp run / timer / hold-multiplier / description change the spec and round-trip", () => {
  const b = engineBackend({...spec(), nodes: spec().nodes.map(n => n.name === "R1" ? {...n, lldp: undefined} : n)});
  const r = run(b, "R1", "show lldp", "conf t", "lldp timer 5");
  assert.match(r[0].output, /not running/); assert.match(r[2].output, /not running/);
  run(b, "R1", "conf t", "lldp run", "lldp timer 5", "lldp hold-multiplier 2", "lldp description lab-router", "end", "write");
  assert.deepEqual(b.spec().nodes.find(n => n.name === "R1").lldp, {txInterval: 5, holdMultiplier: 2, description: "lab-router"});
  const cfg = run(b, "R1", "show running-config")[0].output;
  assert.match(cfg, /lldp run\nlldp timer 5\nlldp hold-multiplier 2\nlldp description lab-router/);
  run(b, "R1", "conf t", "no lldp timer", "no lldp description", "no lldp hold-multiplier", "end");
  assert.deepEqual(b.spec().nodes.find(n => n.name === "R1").lldp, {});
  run(b, "R1", "conf t", "no lldp run", "end");
  assert.equal(b.spec().nodes.find(n => n.name === "R1").lldp, undefined);
});

test("switches have no lldp commands; linux rendering starts lldpd with the timers", () => {
  const b = engineBackend(spec());
  assert.match(run(b, "SW", "conf t", "lldp run")[1].output, /% Unknown/);
  const lines = linuxCommands(b.getConfig("H1"), {kind: "host", ports: b.ports("H1")});
  assert.ok(lines.includes("lldpd") && lines.includes("lldpcli configure lldp tx-interval 10") && lines.includes("lldpcli configure lldp tx-hold 3"));
});
