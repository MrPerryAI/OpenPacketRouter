// IPv6 basics: ipv6 address / ipv6 route commands, the spec keys they make, running-config, and ping to an IPv6 address.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createSession} from "../src/index.js";
import {engineBackend} from "../src/backends/engine.js";
import {ROOT} from "./helpers.js";

const lab = () => JSON.parse(fs.readFileSync(path.join(ROOT, "validate/ipv6/ipv6-lab.json"), "utf8"));
const node = (b, n) => b.spec().nodes.find(x => x.name === n);

test("ipv6 address and ipv6 route build ifaces6, routes6 and gw6; undo removes them", () => {
  const b = engineBackend(lab()), s = createSession(b, "A", {mode: "config"});
  s.exec("interface eth0"); assert.equal(s.exec("ipv6 address 2001:DB8:1::0A/64").output, "");
  assert.equal(node(b, "A").ifaces6.eth0, "2001:db8:1::a/64");   // written in the compressed lowercase form
  s.exec("exit"); s.exec("no ipv6 route ::/0 2001:db8:1::1");
  assert.equal(node(b, "A").gw6, undefined);
  s.exec("ipv6 route 2001:db8:5::/48 2001:db8:1::1"); assert.deepEqual(node(b, "A").routes6, [["2001:db8:5::/48", "2001:db8:1::1"]]);
  s.exec("ipv6 route ::/0 2001:db8:1::1"); assert.equal(node(b, "A").gw6, "2001:db8:1::1");
  s.exec("no ipv6 route 2001:db8:5::/48"); assert.equal(node(b, "A").routes6, undefined);
});

test("bad IPv6 input is refused; IPv6 commands are not for switches", () => {
  const b = engineBackend(lab()), s = createSession(b, "A", {mode: "config"});
  s.exec("interface eth0");
  assert.match(s.exec("ipv6 address 2001:db8:1::/64").output, /%/);       // the network itself
  assert.match(s.exec("ipv6 address 10.0.0.1/24").output, /%/);
  s.exec("exit");
  assert.match(s.exec("ipv6 route 2001:db8:5::/48 nonsense").output, /%/);
  assert.match(s.exec("no ipv6 route 2001:db8:9::/48").output, /%/);
  assert.match(createSession(b, "SW", {mode: "config"}).exec("ipv6 route ::/0 2001:db8:1::1").output, /%/);
});

test("running-config shows IPv6 lines and replaying them on a blank host gives the same spec", () => {
  const b = engineBackend(lab()), rc = createSession(b, "C", {mode: "priv"}).exec("show running-config").output;
  assert.match(rc, /^ ipv6 address 2001:db8:2::c\/64$/m); assert.match(rc, /^ipv6 route 2001:db8:1::\/64 2001:db8:2::1$/m);
  const s0 = lab(); delete node({spec: () => s0}, "C").ifaces6; delete node({spec: () => s0}, "C").routes6;
  const b2 = engineBackend(s0), s = createSession(b2, "C", {mode: "config"});
  s.exec("interface eth0"); s.exec("ipv6 address 2001:db8:2::c/64"); s.exec("exit");
  s.exec("ipv6 route 2001:db8:1::/64 2001:db8:2::1");
  assert.deepEqual(node(b2, "C"), node(b, "C"));
});

test("ping to an IPv6 address from the CLI", () => {
  const b = engineBackend(lab());
  assert.match(createSession(b, "A", {mode: "priv"}).exec("ping 2001:db8:2::c").output, /!|success|2001:db8:2::c|ok/i);
});

test("router ripng: networks, passive interfaces and timers reach the spec, and the running-config round-trips", () => {
  const b = engineBackend(JSON.parse(fs.readFileSync(path.join(ROOT, "validate/ripng/ripng-chain.json"), "utf8"))), s = createSession(b, "R1", {mode: "config"});
  s.exec("no router ripng"); assert.equal(node(b, "R1").ripng, undefined);
  s.exec("router ripng"); s.exec("network eth1"); s.exec("network 2001:db8::/32"); s.exec("passive-interface eth0"); s.exec("timers basic 5 15 10"); s.exec("split-horizon poisoned-reverse");
  assert.deepEqual(node(b, "R1").ripng, {networks: ["eth1", "2001:db8::/32"], passive: ["eth0"], timers: {update: 5, timeout: 15, garbage: 10}, splitHorizon: "poisoned"});
  s.exec("end");
  const cfg = createSession(b, "R1", {mode: "priv"}).exec("show running-config").output;
  assert.match(cfg, /router ripng\n network eth1\n network 2001:db8::\/32\n passive-interface eth0\n timers basic 5 15 10\n split-horizon poisoned-reverse/);
  assert.match(createSession(b, "R1", {mode: "config"}).exec("router ripng").output + "", /^$/);
});
