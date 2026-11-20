// Inter-VLAN routing in the CLI: subinterfaces, SVIs, their show output and the Linux rendering.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createSession} from "../src/index.js";
import {engineBackend} from "../src/backends/engine.js";
import {linuxCommands} from "../src/backends/linux.js";
import {ROOT} from "./helpers.js";

const load = name => JSON.parse(fs.readFileSync(path.join(ROOT, "examples", name, "spec.json"), "utf8"));
const priv = (spec, dev) => { const s = createSession(engineBackend(spec), dev); s.exec("enable"); return s; };

test("l3 switch: show ip route and show arp work, with SVIs as connected routes", () => {
  const s = priv(load("l3-switch"), "SW1");
  const r = s.exec("show ip route | json");
  assert.deepEqual(r.json.map(x => [x.prefix, x.protocol, x.interface]), [
    ["10.0.10.0/24", "connected", "vlan10"], ["10.0.20.0/24", "connected", "vlan20"],
    ["10.0.30.0/24", "connected", "vlan30"], ["10.9.0.0/24", "static", "vlan30"]]);
  assert.ok(Array.isArray(s.exec("show arp | json").json));
});

test("l3 switch: show vlan brief lists SVIs beside their VLAN, not as VLAN 1 ports", () => {
  const s = priv(load("l3-switch"), "SW1");
  const j = s.exec("show vlan brief | json").json;
  assert.ok(!j.vlans.some(v => v.vlan === 1), "no phantom VLAN 1");
  const v10 = j.vlans.find(v => v.vlan === 10);
  assert.deepEqual([v10.accessPorts, v10.svi, v10.address], [["p1"], "vlan10", "10.0.10.1/24"]);
  assert.match(s.exec("show vlan brief").output, /vlan10 10\.0\.10\.1\/24/);
});

test("l3 switch: an SVI is up when a port carries its VLAN", () => {
  const rows = priv(load("l3-switch"), "SW1").exec("show ip interface brief | json").json;
  assert.equal(rows.find(r => r.name === "vlan10").link, "up");
});

test("a plain VLAN switch keeps the old show vlan brief shape", () => {
  const j = priv(load("vlans"), "SW1").exec("show vlan brief | json").json;
  assert.ok(j.vlans.every(v => !("svi" in v)));
});

test("router on a stick: subinterfaces show in the interface list and are configurable", () => {
  const s = priv(load("intervlan-roas"), "R");
  const rows = s.exec("show ip interface brief | json").json;
  assert.deepEqual(rows.map(r => r.name), ["eth0", "eth0.10", "eth0.20"]);
  s.exec("configure terminal"); s.exec("interface eth0.30");
  assert.ok(!/^%/.test(s.exec("ip address 10.0.30.1/24").output));
  s.exec("end");
  assert.ok(s.exec("show ip route | json").json.some(r => r.interface === "eth0.30"));
  assert.match(s.exec("show running-config").output, /interface eth0\.30\n ip address 10\.0\.30\.1\/24/);
});

test("linux: subinterfaces are created on their parent, SVIs on the bridge itself", () => {
  const roas = engineBackend(load("intervlan-roas")), svi = engineBackend(load("l3-switch"));
  const r = linuxCommands(roas.getConfig("R"), {kind: "router", ports: roas.ports("R")});
  assert.ok(r.indexOf("ip link add link eth0 name eth0.10 type vlan id 10") < r.indexOf("ip addr add 10.0.10.1/24 dev eth0.10"), r.join("\n"));
  const w = linuxCommands(svi.getConfig("SW1"), {kind: "switch", ports: svi.ports("SW1")});
  assert.ok(w.includes("ip link add link br0 name vlan10 type vlan id 10"), w.join("\n"));
  assert.ok(w.includes("bridge vlan add dev br0 vid 10 self"));
  assert.ok(!w.includes("ip link set vlan10 master br0"), "an SVI is not a bridge port");
  assert.ok(w.includes("sysctl -w net.ipv4.ip_forward=1"));
  assert.ok(w.includes("ip route add 10.9.0.0/24 via 10.0.30.2"));
  const p = linuxCommands(svi.getConfig("SW1"), {kind: "switch", ports: svi.ports("SW1"), labParity: true});
  assert.ok(p.every(l => !/conf\.[^ ]*\.\d+\./.test(l) || /\//.test(l)), "dotted names use the / form in sysctl keys");
});
