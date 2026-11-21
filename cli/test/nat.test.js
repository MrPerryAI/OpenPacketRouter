// NAT: ip nat inside/outside, ip nat inside source overload/static, show ip nat, the spec they make, the engine's behaviour, the Linux rendering.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createSession} from "../src/index.js";
import {engineBackend} from "../src/backends/engine.js";
import {linuxCommands} from "../src/backends/linux.js";
import {runActions} from "../../engine/src/index.js";
import {ROOT} from "./helpers.js";

const spec = () => JSON.parse(fs.readFileSync(path.join(ROOT, "examples/nat-lab/spec.json"), "utf8"));
const blank = () => { const s = spec(); s.nodes = s.nodes.map(n => n.name === "R" ? (({nat, ...r}) => r)(n) : n); return s; };
const run = (s, lines) => lines.map(l => s.exec(l).output);

test("configure NAT: the spec gets nat.inside/outside/overload/static", () => {
  const b = engineBackend(blank()), s = createSession(b, "R", {mode: "config"});
  const out = run(s, ["interface eth0", "ip nat inside", "exit", "interface eth1", "ip nat outside", "exit",
    "ip nat inside source overload 10.1.0.0/24", "ip nat inside source static 10.1.0.10 203.0.113.10",
    "ip nat inside source static tcp 10.1.0.20 80 203.0.113.1 8080", "end"]);
  assert.deepEqual(out.filter(Boolean), []);
  assert.deepEqual(b.spec().nodes.find(n => n.name === "R").nat, spec().nodes.find(n => n.name === "R").nat);
});

test("the engine translates what the CLI configured", () => {
  const b = engineBackend(blank()), s = createSession(b, "R", {mode: "config"});
  const ping = [{do: "ping", src: "B", dst: "203.0.113.50"}];
  assert.equal(runActions(b.spec(), ping)[0].result.ok, false);   // S has no route back to a private address
  run(s, ["interface eth0", "ip nat inside", "exit", "interface eth1", "ip nat outside", "exit", "ip nat inside source overload"]);
  assert.equal(runActions(b.spec(), ping)[0].result.ok, true);   // now S sees R's outside address
});

test("running-config shows NAT and replaying it rebuilds it", () => {
  const b = engineBackend(spec()), text = createSession(b, "R", {mode: "priv"}).exec("show running-config").output;
  for (const l of ["ip nat inside source overload 10.1.0.0/24", "ip nat inside source static 10.1.0.10 203.0.113.10",
    "ip nat inside source static tcp 10.1.0.20 80 203.0.113.1 8080", " ip nat inside", " ip nat outside"]) assert.ok(text.includes(l), l);
  const b2 = engineBackend(blank()), s2 = createSession(b2, "R", {mode: "config"});
  for (const l of text.split("\n")) if (l && l !== "!") s2.exec(l.trimStart());
  assert.deepEqual(b2.spec().nodes.find(n => n.name === "R").nat, spec().nodes.find(n => n.name === "R").nat);
});

test("mistakes are refused with a message", () => {
  const b = engineBackend(spec()), s = createSession(b, "R", {mode: "config"});
  assert.match(s.exec("ip nat inside source static 10.1.0.10 203.0.113.99").output, /already has a fixed outside address/);
  assert.match(s.exec("ip nat inside source static 10.1.0.77 203.0.113.10").output, /already mapped/);
  assert.match(s.exec("ip nat inside source static 10.1.0.20 80 203.0.113.1 8080").output, /%/);   // port forms need tcp or udp
  assert.match(s.exec("no ip nat inside source static 10.1.0.99 203.0.113.99").output, /No such fixed mapping/);
  s.exec("interface eth0"); s.exec("no ip nat"); assert.match(s.exec("no ip nat").output, /neither inside nor outside/);
  assert.match(createSession(b, "A", {mode: "config"}).exec("ip nat inside source overload").output, /%/);   // hosts do not translate
});

test("show ip nat translations lists fixed mappings and live flows; | json is data", () => {
  const b = engineBackend(spec()), p = createSession(b, "R", {mode: "priv"});
  const before = JSON.parse(p.exec("show ip nat translations | json").output).translations;
  assert.equal(before.length, 2); assert.ok(before.every(r => r.static));
  const acts = runActions(b.spec(), [{do: "ping", src: "B", dst: "203.0.113.50"}]);
  assert.equal(acts[0].result.ok, true);
  assert.match(p.exec("show ip nat statistics").output, /Inside interfaces:  eth0/);
  assert.match(p.exec("show ip nat translations").output, /Inside global/);
});

test("Linux rendering: dnat, snat, masquerade and the secondary outside address", () => {
  const b = engineBackend(spec()), cmds = linuxCommands(b.getConfig("R"), {kind: "router"});
  assert.ok(cmds.includes('nft add rule ip opr_nat pre iifname { "eth1" } ip daddr 203.0.113.10 dnat to 10.1.0.10'), cmds.join("\n"));
  assert.ok(cmds.includes('nft add rule ip opr_nat pre iifname { "eth1" } ip daddr 203.0.113.1 tcp dport 8080 dnat to 10.1.0.20:80'));
  assert.ok(cmds.includes('nft add rule ip opr_nat post iifname { "eth0" } oifname { "eth1" } ip saddr 10.1.0.10 snat to 203.0.113.10'));
  assert.ok(cmds.includes('nft add rule ip opr_nat post iifname { "eth0" } oifname { "eth1" } ip saddr 10.1.0.0/24 masquerade'));
  assert.ok(cmds.includes("ip addr add 203.0.113.10/24 dev eth1")); assert.equal(cmds.filter(c => c.startsWith("ip addr add 203.0.113.1/")).length, 1)   // R's own address is not added twice;
  assert.deepEqual(linuxCommands(b.getConfig("A"), {kind: "host"}).filter(c => c.includes("opr_nat")), []);
});
