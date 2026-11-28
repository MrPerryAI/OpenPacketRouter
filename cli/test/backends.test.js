// Renderers for real systems, and the OpenConfig export.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {model as M} from "../src/index.js";
import {engineBackend} from "../src/backends/engine.js";
import {linuxCommands} from "../src/backends/linux.js";
import {frrConfig} from "../src/backends/frr.js";
import {uciCommands} from "../src/backends/openwrt.js";
import {ROOT} from "./helpers.js";

const spec = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const render = (file, dev, fn) => { const b = engineBackend(spec(file)); return fn(b.getConfig(dev), {kind: b.kind(dev), ports: b.ports(dev)}); };

test("linux: a router gets forwarding, addresses and routes", () => {
  const out = render("validate/l3/fti-routed.json", "R-NOC", linuxCommands);
  assert.equal(out[0], "sys" + "ctl -w net.ipv4.ip_forward=1");
  assert.ok(out.includes("ip addr add 10.0.0.1/24 dev lan"), out.join("\n"));
  assert.ok(out.some(l => /^ip route add (default|\d+\.\d+\.\d+\.\d+\/\d+) via /.test(l)), out.join("\n"));
});

test("linux: a spanning-tree switch matches the validator's bridge settings", () => {
  const s = spec("validate/l2/stp-ring.json"), sw = s.nodes.find(n => n.kind === "switch");
  const out = render("validate/l2/stp-ring.json", sw.name, linuxCommands);
  assert.match(out[0], new RegExp(`^ip link add br0 type bridge stp_state 1 priority ${sw.stp.priority ?? 32768} hello_time ${sw.stp.hello * 100} max_age ${sw.stp.maxAge * 100} forward_delay ${sw.stp.forwardDelay * 100}$`));
  assert.ok(out.includes(`ip link set br0 address ${sw.stp.mac}`));
});

test("linux: VLAN ports become bridge vlan entries", () => {
  const s = spec("validate/l2/vlan-native.json"), sw = s.nodes.find(n => n.kind === "switch" && n.vlans);
  const out = render("validate/l2/vlan-native.json", sw.name, linuxCommands).join("\n");
  assert.match(out, /vlan_filtering 1/);
  for (const [p, c] of Object.entries(sw.vlans)) {
    if (c.access) assert.match(out, new RegExp(`bridge vlan add dev ${p} vid ${c.access} pvid untagged`));
    if (c.native !== undefined) assert.match(out, new RegExp(`bridge vlan add dev ${p} vid ${c.native} pvid untagged`));
  }
});

test("linux: shaping and the DHCP relay", () => {
  assert.match(render("examples/bottleneck/spec.json", spec("examples/bottleneck/spec.json").links.find(l => l[3])[0].split(":")[0], linuxCommands).join("\n"), /tc qdisc add dev \S+ root tbf rate \S+ burst \d+ limit \d+/);
  assert.match(render("examples/dhcp-relay/spec.json", "R1", linuxCommands).join("\n"), /--dhcp-relay=10\.1\.0\.1,10\.0\.0\.1/);
});

test("frr and openwrt stubs render addresses and static routes", () => {
  const f = render("validate/l3/fti-routed.json", "R-NOC", frrConfig);
  assert.match(f, /^hostname R-NOC/); assert.match(f, /interface lan\n ip address 10\.0\.0\.1\/24/); assert.match(f, /\nip route /);
  const u = render("validate/l3/fti-routed.json", "R-NOC", uciCommands);
  assert.ok(u.includes("set network.lan.ipaddr='10.0.0.1'") && u.includes("set network.lan.netmask='255.255.255.0'"), u.join("\n"));
  assert.equal(u[u.length - 1], "commit network");
});

test("OpenConfig export uses lists with their key leaves", () => {
  const oc = M.toOpenConfig(engineBackend(spec("validate/l3/fti-routed.json")).getConfig("R-NOC"));
  const ifs = oc["openconfig-interfaces:interfaces"].interface;
  assert.ok(Array.isArray(ifs) && ifs.some(i => i.name === "lan"));
  const lan = ifs.find(i => i.name === "lan");
  assert.equal(lan.subinterfaces.subinterface[0].index, 0);
  assert.deepEqual(lan.subinterfaces.subinterface[0].ipv4.addresses.address[0].config, {ip: "10.0.0.1", "prefix-length": 24});
  const ni = oc["openconfig-network-instance:network-instances"]["network-instance"][0];
  assert.equal(ni.name, "default");
  assert.ok(Array.isArray(ni.protocols.protocol[0]["static-routes"].static));
});

test("linux: every spanning-tree port gets the engine's cost (19 unless set)", () => {
  const s = spec("validate/l2/stp-tiebreak.json"), sw = s.nodes.find(n => n.kind === "switch" && n.stp);
  const b = engineBackend(s), out = linuxCommands(b.getConfig(sw.name), {kind: "switch", ports: b.ports(sw.name)});
  for (const p of b.ports(sw.name)) assert.ok(out.includes(`ip link set ${p} type bridge_slave cost ${(sw.stp.cost || {})[p] ?? 19}`), `${p}\n${out.join("\n")}`);
});

test("linux: --lab-parity adds the validators' settings (no IPv6, no redirects, no ICMP rate limit, no rp_filter)", () => {
  const b = engineBackend(spec("validate/l3/fti-routed.json"));
  const plain = linuxCommands(b.getConfig("R-NOC"), {kind: "router", ports: b.ports("R-NOC")});
  const lab = linuxCommands(b.getConfig("R-NOC"), {kind: "router", ports: b.ports("R-NOC"), labParity: true}).join("\n");
  assert.ok(!plain.some(l => l.includes("disable_ipv6")));
  for (const k of ["net.ipv6.conf.all.disable_ipv6=1", "net.ipv4.conf.all.send_redirects=0", "net.ipv4.icmp_ratelimit=0", "net.ipv4.conf.all.rp_filter=0",
    "net.ipv6.conf.lan.disable_ipv6=1", "net.ipv4.conf.lan.rp_filter=0"]) assert.ok(lab.includes(k), k);
});

test("openwrt renders IPv6 addresses and static routes", () => {
  const s = spec("validate/l3/fti-routed.json"), b = engineBackend(s);
  const node = s.nodes.find(n => n.name === "R-NOC"); node.ifaces6 = {lan: "2001:db8:1::1/64"}; node.routes6 = [["2001:db8:2::/64", "2001:db8:1::2"]];
  const u = uciCommands(engineBackend(s).getConfig("R-NOC"), {ports: engineBackend(s).ports("R-NOC")});
  assert.ok(u.includes("add_list network.lan.ip6addr='2001:db8:1::1/64'"), u.join("\n"));
  assert.ok(u.includes("set network.route6_0.target='2001:db8:2::/64'") && u.includes("set network.route6_0.gateway='2001:db8:1::2'"), u.join("\n"));
});

test("openwrt renders switch VLANs as a bridge with bridge-vlan sections", () => {
  const s = spec("examples/vlans/spec.json"), b = engineBackend(s), name = s.nodes.find(n => n.kind === "switch").name;
  const u = uciCommands(b.getConfig(name), {ports: b.ports(name)}).join("\n");
  assert.match(u, /set network\.br0\.type='bridge'/);
  assert.match(u, /set network\.bvlan10=bridge-vlan[\s\S]*add_list network\.bvlan10\.ports='p1:u\*'[\s\S]*add_list network\.bvlan10\.ports='trunk:t'/);
});
