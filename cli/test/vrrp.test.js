// VRRP commands: configure per interface, show vrrp [| json], running-config round trip, Linux (keepalived) rendering.
import test from "node:test";
import assert from "node:assert/strict";
import {createSession} from "../src/index.js";
import {engineBackend} from "../src/backends/engine.js";
import {linuxCommands} from "../src/backends/linux.js";

const spec = () => ({format: "openpacketrouter.spec/1", name: "vrrp-cli", nodes: [
  {name: "R1", kind: "router", ifaces: {eth0: "10.0.0.1/24"}, vrrp: [{iface: "eth0", vrid: 1, ip: "10.0.0.254", priority: 200}]},
  {name: "R2", kind: "router", ifaces: {eth0: "10.0.0.2/24"}},
  {name: "H1", kind: "host", ifaces: {eth0: "10.0.0.10/24"}, gw: "10.0.0.254"},
  {name: "S1", kind: "switch"}], links: [["R1:eth0", "S1:p1"], ["R2:eth0", "S1:p2"], ["H1:eth0", "S1:p3"]]});

const run = (backend, device, ...cmds) => { const s = createSession(backend, device, {mode: "priv"}); return cmds.map(c => s.exec(c.replace(/^(conf t)$/, "configure terminal"))); };

test("show vrrp lists the group with its state, and has a JSON form", () => {
  const b = engineBackend(spec());
  const [text, js] = run(b, "R1", "show vrrp", "show vrrp | json");
  assert.match(text.output, /master/);
  assert.deepEqual([js.json[0].interface, js.json[0].group, js.json[0].state, js.json[0].address, js.json[0].priority, js.json[0].preempt], ["eth0", 1, "master", "10.0.0.254", 200, true]);
  assert.match(run(b, "R2", "show vrrp")[0].output, /No VRRP groups/);
});

test("configure: vrrp commands on an interface change the spec and round-trip", () => {
  const b = engineBackend(spec());
  run(b, "R2", "conf t", "interface eth0", "vrrp 1 address 10.0.0.254", "vrrp 1 priority 100", "vrrp 1 interval 2", "no vrrp 1 preempt", "vrrp 1 virtual-mac", "end", "write");
  assert.deepEqual(b.spec().nodes.find(n => n.name === "R2").vrrp, [{iface: "eth0", vrid: 1, ip: "10.0.0.254", priority: 100, interval: 2, preempt: false, virtualMac: true}]);
  const cfg = run(b, "R2", "show running-config")[0].output;
  assert.match(cfg, / vrrp 1 address 10.0.0.254\n vrrp 1 priority 100\n vrrp 1 interval 2\n no vrrp 1 preempt\n vrrp 1 virtual-mac/);
  run(b, "R2", "conf t", "interface eth0", "vrrp 1 preempt", "no vrrp 1 virtual-mac", "end");
  assert.deepEqual(b.spec().nodes.find(n => n.name === "R2").vrrp, [{iface: "eth0", vrid: 1, ip: "10.0.0.254", priority: 100, interval: 2}]);
  run(b, "R2", "conf t", "interface eth0", "no vrrp 1", "end");
  assert.equal(b.spec().nodes.find(n => n.name === "R2").vrrp, undefined);
});

test("the second router joins the group and the CLI sees the election", () => {
  const b = engineBackend(spec());
  run(b, "R2", "conf t", "interface eth0", "vrrp 1 address 10.0.0.254", "end", "write");
  const js = run(b, "R2", "show vrrp | json")[0].json[0];
  assert.deepEqual([js.state, js.master], ["backup", "10.0.0.1"]);
});

test("only routers, and a group needs an address; linux rendering writes a keepalived config", () => {
  const b = engineBackend(spec());
  assert.match(run(b, "H1", "conf t", "interface eth0", "vrrp 1 address 10.0.0.254")[2].output, /% Unknown/);
  assert.match(run(b, "R2", "conf t", "interface eth0", "no vrrp 7")[2].output, /not set up/);
  const lines = linuxCommands(b.getConfig("R1"), {kind: "router", ports: b.ports("R1")});
  const conf = lines.find(l => l.includes("/etc/keepalived/keepalived.conf") && l.startsWith("printf"));
  assert.ok(conf && conf.includes("'  virtual_router_id 1'") && conf.includes("'  priority 200'") && conf.includes("10.0.0.254/24 dev eth0"));
  assert.ok(lines.includes("keepalived -P -f /etc/keepalived/keepalived.conf"));
});
