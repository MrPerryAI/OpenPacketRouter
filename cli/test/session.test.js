// Modes, abbreviations, ? help, Tab, errors, do, pipes, all-or-nothing configuration.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createSession, compile, DEFINITIONS} from "../src/index.js";
import {engineBackend} from "../src/backends/engine.js";
import {ROOT} from "./helpers.js";

const load = name => JSON.parse(fs.readFileSync(path.join(ROOT, "examples", name, "spec.json"), "utf8"));
const routed = () => engineBackend(load("routed-lan-dns"));
const ok = (s, line) => { const r = s.exec(line); assert.ok(!/^%|\n%/.test(r.output), `${line}: ${r.output}`); return r; };

test("modes and prompts", () => {
  const s = createSession(routed(), "R1");
  assert.equal(s.prompt(), "R1>");
  ok(s, "enable"); assert.equal(s.prompt(), "R1#");
  ok(s, "configure terminal"); assert.equal(s.prompt(), "R1(config)#");
  ok(s, "interface eth0"); assert.equal(s.prompt(), "R1(config-if)#");
  ok(s, "exit"); assert.equal(s.prompt(), "R1(config)#");
  ok(s, "ip dhcp pool LAN"); assert.equal(s.prompt(), "R1(config-dhcp)#");
  ok(s, "end"); assert.equal(s.prompt(), "R1#");
  ok(s, "disable"); assert.equal(s.prompt(), "R1>");
  ok(s, "exit"); assert.equal(s.closed, true);
});

test("abbreviations, and errors that say what is wrong", () => {
  const s = createSession(routed(), "R1");
  ok(s, "en"); ok(s, "conf t"); ok(s, "int eth1"); ok(s, "ip add 10.1.0.2 255.255.255.0");
  assert.match(s.exec("sh").output, /Ambiguous: "sh" could be shape, shutdown/);
  assert.match(s.exec("bogus").output, /Unknown word/);
  assert.match(s.exec("ip").output, /incomplete/);
  assert.match(s.exec("interface 9bad").output, /Unknown word|No interface/);
  ok(s, "end");
  assert.match(s.exec("show running-config").output, /interface eth1\n ip address 10\.1\.0\.2\/24/);
});

test("? lists what comes next with help; Tab completes", () => {
  const s = createSession(routed(), "R1", {mode: "priv"});
  const h = s.help("show ip ?");
  assert.match(h, /route\s+Routing table/); assert.match(h, /interface/);
  assert.match(s.help("show ip route ?"), /<cr>/);
  assert.equal(s.help("sh?"), "show");
  assert.deepEqual(s.complete("sh"), {line: "show ", options: ["show"]});
  assert.equal(s.complete("show ip r").line, "show ip route ");
  ok(s, "conf t");
  assert.match(s.help("interface ?"), /eth0\s+Interface name/);
  assert.match(s.help("ip route ?"), /A\.B\.C\.D\/M/);
  assert.equal(s.complete("interface e").line, "interface eth");     // eth0 and eth1: the common part
  assert.deepEqual(s.complete("interface e").options, ["eth0", "eth1"]);
});

test("user mode cannot see the configuration; do runs privileged commands from config", () => {
  const s = createSession(routed(), "R1");
  assert.match(s.exec("show running-config").output, /Unknown word/);
  ok(s, "enable"); ok(s, "conf t"); ok(s, "int eth0");
  assert.match(ok(s, "do show ip route").output, /10\.0\.0\.0\/24/);
  assert.equal(s.prompt(), "R1(config-if)#");
});

test("a config-mode command typed in interface mode runs and leaves interface mode", () => {
  const s = createSession(routed(), "R1", {mode: "config"});
  ok(s, "interface eth0"); ok(s, "ip route 10.9.0.0/16 10.0.0.10");
  assert.equal(s.prompt(), "R1(config)#");
  ok(s, "interface eth0"); ok(s, "interface eth1");
  assert.equal(s.selection.iface, "eth1");
});

test("a refused change keeps the old configuration and says why", () => {
  const b = routed(), s = createSession(b, "R1", {mode: "config"});
  const before = JSON.stringify(b.spec());
  const r = s.exec("ip route 10.9.0.0/16 192.168.77.1");     // next hop on none of its networks
  assert.match(r.output, /^% .*192\.168\.77\.1/);
  assert.equal(JSON.stringify(b.spec()), before);
  assert.match(s.exec("hostname PC1").output, /already the name/);
});

test("hostname renames the device and its cables", () => {
  const b = routed(), s = createSession(b, "R1", {mode: "config"});
  ok(s, "hostname CORE");
  assert.equal(s.prompt(), "CORE(config)#");
  assert.ok(b.spec().nodes.some(n => n.name === "CORE"));
  assert.ok(b.spec().links.flat().some(x => typeof x === "string" && x.startsWith("CORE:")));
});

test("a DHCP pool stays visible while it is incomplete, and reaches the spec when it has a range", () => {
  const b = routed(), s = createSession(b, "DNS", {mode: "config"});
  ok(s, "ip dhcp pool LAN");
  assert.equal(b.spec().nodes.find(n => n.name === "DNS").services.dhcp, undefined);
  assert.match(s.exec("do show running-config").output, /ip dhcp pool LAN/);
  ok(s, "range 10.1.0.100 10.1.0.120"); ok(s, "lease 600");
  assert.deepEqual(b.spec().nodes.find(n => n.name === "DNS").services.dhcp, {range: ["10.1.0.100", "10.1.0.120"], lease: 600});
});

test("switch ports: access, trunk, spanning tree, shutdown", () => {
  const b = engineBackend(load("loop-with-stp")), sw = b.spec().nodes.find(n => n.kind === "switch").name;
  const s = createSession(b, sw, {mode: "config"});
  const port = b.ports(sw)[0];
  ok(s, `interface ${port}`); ok(s, "switchport mode trunk"); ok(s, "switchport trunk allowed vlan 10,20-22"); ok(s, "switchport trunk native vlan 10");
  ok(s, "spanning-tree cost 100"); ok(s, "shutdown");
  const n = b.spec().nodes.find(x => x.name === sw);
  assert.deepEqual(n.vlans[port], {trunk: [10, 20, 21, 22], native: 10});
  assert.equal(n.stp.cost[port], 100);
  assert.deepEqual(n.blocked, [port]);
  assert.match(s.exec("switchport access vlan 5").output, /trunk/);
  ok(s, "no spanning-tree");
  assert.equal(b.spec().nodes.find(x => x.name === sw).stp, undefined);
});

test("every show command answers | json with JSON", () => {
  const table = compile(DEFINITIONS);
  for (const [specName, dev] of [["routed-lan-dns", "R1"], ["loop-with-stp", null], ["dhcp-relay", "DHCP"]]) {
    const b = engineBackend(load(specName)), device = dev || b.spec().nodes.find(n => n.kind === "switch").name;
    const s = createSession(b, device, {mode: "priv"});
    const kind = b.kind(device);
    for (const c of table.commands.filter(c => c.handler.startsWith("show.") && c.modes.includes("priv") && (!c.kinds || c.kinds.includes(kind)))) {
      const r = s.exec(`${c.syntax} | json`);
      assert.doesNotThrow(() => JSON.parse(r.output), `${device}: ${c.syntax} | json -> ${r.output}`);
    }
  }
});

test("pipes: include and exclude; pipes only on show", () => {
  const s = createSession(routed(), "R1", {mode: "priv"});
  assert.equal(s.exec("show running-config | include address").output, " ip address 10.0.0.1/24\n ip address 10.1.0.1/24");
  assert.ok(!s.exec("show running-config | exclude !").output.includes("!"));
  assert.match(s.exec("ping 10.1.0.53 | json").output, /Only show commands/);
});

test("ping and traceroute run the engine", () => {
  const s = createSession(routed(), "PC1");
  assert.match(ok(s, "ping 10.1.0.53").output, /Reply from 10\.1\.0\.53/);
  assert.equal(ok(s, "ping 10.1.0.53").changed, "actions");
  assert.match(ok(s, "traceroute 10.1.0.53").output, /1\s+10\.0\.0\.1/);
  ok(s, "enable");
  assert.match(ok(s, "show arp").output, /10\.0\.0\.1/);
});

test("hosted backend: the host owns the spec and the unplugged cables (Studio's shape)", () => {
  const host = {spec: load("routed-lan-dns"), cut: new Set(), runs: []};
  const b = engineBackend({
    spec: () => host.spec, setSpec: s => { host.spec = s; return []; },
    cut: () => host.cut, setCut: c => { host.cut = c; },
    run: a => { host.runs.push(a); return {ok: true, from: a.dst, rtt_ms: 1}; },
  });
  const s = createSession(b, "R1", {mode: "config"});
  ok(s, "interface eth1"); ok(s, "shutdown");
  const i = host.spec.links.findIndex(l => l.includes("R1:eth1"));
  assert.ok(host.cut.has(i));
  assert.match(s.exec("do show running-config").output, /interface eth1\n ip address 10\.1\.0\.1\/24\n shutdown/);
  host.cut = new Set();                                   // the user plugs the cable back in on the map
  assert.doesNotMatch(s.exec("do show running-config").output, /shutdown/);
  ok(s, "end"); ok(s, "ping 10.1.0.53");
  assert.deepEqual(host.runs, [{do: "ping", dst: "10.1.0.53", src: "R1"}]);
});
