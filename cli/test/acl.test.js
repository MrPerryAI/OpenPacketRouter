// IPv4 access lists: ip access-list / permit / deny / ip access-group, show access-lists, the spec they make, the Linux rendering.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createSession} from "../src/index.js";
import {engineBackend} from "../src/backends/engine.js";
import {linuxCommands} from "../src/backends/linux.js";
import {runActions} from "../../engine/src/index.js";
import {ROOT} from "./helpers.js";

const spec = () => JSON.parse(fs.readFileSync(path.join(ROOT, "examples/acl-lab/spec.json"), "utf8"));
const blank = () => { const s = spec(); s.nodes = s.nodes.map(n => n.name === "R" ? (({acl, ...r}) => r)(n) : n); return s; };
const run = (s, lines) => lines.map(l => s.exec(l).output);

test("configure a list and apply it: the spec gets acl.lists and acl.bind", () => {
  const b = engineBackend(blank()), s = createSession(b, "R", {mode: "config"});
  const out = run(s, ["ip access-list WEB", "permit tcp 10.1.0.0/24 10.2.0.10:80", "permit icmp any any type 8", "deny udp any any:9000-9100", "exit",
    "interface eth0", "ip access-group WEB in", "end"]);
  assert.deepEqual(out.filter(Boolean), []);
  assert.deepEqual(b.spec().nodes.find(n => n.name === "R").acl, {
    lists: {WEB: [{action: "permit", proto: "tcp", src: "10.1.0.0/24", dst: "10.2.0.10", dport: 80}, {action: "permit", proto: "icmp", icmpType: 8},
      {action: "deny", proto: "udp", dport: "9000-9100"}]},
    bind: {eth0: {in: "WEB"}}});
});

test("the lists change what the engine does", () => {
  const b = engineBackend(blank()), s = createSession(b, "R", {mode: "config"});
  const ping = [{do: "ping", src: "A", dst: "10.2.0.10"}];
  assert.equal(runActions(b.spec(), ping)[0].result.ok, true);
  run(s, ["ip access-list ONLY-UDP", "permit udp any any", "exit", "interface eth0", "ip access-group ONLY-UDP in"]);
  assert.equal(runActions(b.spec(), ping)[0].result.error, "administratively prohibited");
});

test("mistakes are refused with a message", () => {
  const b = engineBackend(blank()), s = createSession(b, "R", {mode: "config"});
  assert.match(s.exec("interface eth0").output + s.exec("ip access-group NOPE in").output, /No access list named NOPE/);
  s.exec("exit"); s.exec("ip access-list L");
  assert.match(s.exec("permit ip any any:80").output, /only work with tcp and udp/);
  assert.match(s.exec("permit tcp any any:70000").output, /%/);
  assert.match(s.exec("permit tcp any any:90-80").output, /%/);
  assert.match(s.exec("no rule 3").output, /0 rules/);
  s.exec("permit ip any any"); s.exec("exit"); s.exec("interface eth0"); s.exec("ip access-group L out"); s.exec("exit");
  assert.match(s.exec("no ip access-list L").output, /still applied out on eth0/);
  s.exec("interface eth0"); s.exec("no ip access-group out"); s.exec("exit");
  assert.equal(s.exec("no ip access-list L").output, "");
  assert.match(createSession(b, "A", {mode: "config"}).exec("ip access-list X").output, /%/);   // hosts have no access lists
});

test("no rule N removes one rule; show access-lists numbers them; | json is data", () => {
  const b = engineBackend(spec()), s = createSession(b, "R", {mode: "config"});
  s.exec("ip access-list TO-SERVERS"); assert.equal(s.exec("no rule 1").output, "");
  const p = createSession(b, "R", {mode: "priv"});
  const text = p.exec("show access-lists TO-SERVERS").output;
  assert.match(text, /Access list TO-SERVERS \(applied out on eth1\)/); assert.match(text, /1  permit ip any any/); assert.match(text, /implicit deny/);
  const j = JSON.parse(p.exec("show access-lists | json").output).accessLists;
  assert.deepEqual(j.map(l => l.name), ["FROM-LAN", "TO-SERVERS", "TO-LAN"]);
  assert.deepEqual(j[1].rules.map(r => r.number), [1]); assert.deepEqual(j[1].applied, [{interface: "eth1", direction: "out"}]);
  assert.match(p.exec("show access-lists NOPE").output, /No access list named NOPE/);
});

test("Linux rendering: nftables rules on iifname/oifname with the implicit deny", () => {
  const b = engineBackend(spec()), cmds = linuxCommands(b.getConfig("R"), {kind: "router"}).filter(c => c.startsWith("nft"));
  assert.ok(cmds.some(c => c.includes("hook prerouting")) && cmds.some(c => c.includes("hook forward")));
  assert.ok(cmds.includes('nft add rule ip opr_acl acl_in iifname "eth0" ip daddr 10.2.0.10 udp dport 53 accept'), cmds.join("\n"));
  assert.ok(cmds.includes('nft add rule ip opr_acl acl_in iifname "eth0" icmp type 8 ip saddr 10.1.0.0/24 ip daddr 10.2.0.0/24 accept'), cmds.join("\n"));
  assert.ok(cmds.includes('nft add rule ip opr_acl acl_out oifname "eth1" udp dport 9000-9100 reject with icmp type admin-prohibited'));
  assert.ok(cmds.includes('nft add rule ip opr_acl acl_out oifname "eth1" reject with icmp type admin-prohibited'));
  assert.deepEqual(linuxCommands(b.getConfig("A"), {kind: "host"}).filter(c => c.startsWith("nft")), []);
});
