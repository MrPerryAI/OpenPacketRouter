import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {runActions, validateSpec} from "../src/index.js";
import {ip6ToInt, intToIp6, parseCidr6, solicitedNode, multicastMac} from "../src/addr6.js";

const lab = () => JSON.parse(fs.readFileSync(new URL("../../validate/ipv6/ipv6-lab.json", import.meta.url)));
const actions = () => JSON.parse(fs.readFileSync(new URL("../../validate/ipv6/ipv6-lab.actions.json", import.meta.url)));

test("address helpers: parse, compress, solicited-node group and its MAC", () => {
  assert.equal(intToIp6(ip6ToInt("2001:0db8:0000:0000:0000:0000:0000:0001")), "2001:db8::1");
  assert.equal(intToIp6(ip6ToInt("::")), "::");
  assert.equal(intToIp6(ip6ToInt("fe80::1:0:0:1")), "fe80::1:0:0:1");   // the longest run of zero groups is compressed
  assert.equal(intToIp6(ip6ToInt("1:0:0:2:0:0:0:3")), "1:0:0:2::3");
  assert.equal(parseCidr6("2001:db8:1::7/64").cidr, "2001:db8:1::/64");
  assert.equal(solicitedNode("2001:db8::5:1"), "ff02::1:ff05:1");
  assert.equal(multicastMac("ff02::1:ff05:1"), "33:33:ff:05:00:01");
  assert.throws(() => ip6ToInt("1::2::3")); assert.throws(() => ip6ToInt("12345::1"));
});

test("the IPv6 lab passes the spec check; bad IPv6 keys are caught", () => {
  const v = validateSpec(lab(), actions());
  assert.ok(v.ok, JSON.stringify(v.errors)); assert.deepEqual(v.warnings, []);
  const s = lab();
  s.nodes[1].ifaces6.eth0 = "10.0.0.1/24"; s.nodes[1].gw6 = "2001:db8:9::1"; s.nodes[4].routes6 = [["2001:db8:1::/64", "nope"]];
  const paths = validateSpec(s).errors.map(e => e.path);
  for (const p of ["$.nodes[1].ifaces6.eth0", "$.nodes[4].routes6[0]"]) assert.ok(paths.includes(p), p);
});

test("ping6 on the link: one solicitation, one advertisement, then the echo", () => {
  const [r] = runActions(lab(), [{do: "ping", src: "A", dst: "2001:db8:1::b"}]);
  assert.deepEqual([r.result.ok, r.result.from], [true, "2001:db8:1::b"]);
  assert.equal(r.frames["A:eth0>SW:p1"], 2);   // NS + echo request
  assert.equal(r.frames["B:eth0>SW:p2"], 2);   // NA + echo reply (the reply needs no solicitation: B learned A from the NS)
});

test("routed ping6, hop limit 1, no route, unresolvable neighbor", () => {
  const out = runActions(lab(), actions());
  const by = (src, dst, ttl) => out.find(o => o.action.src === src && o.action.dst === dst && o.action.ttl === ttl).result;
  assert.deepEqual([by("A", "2001:db8:2::c").ok, by("C", "2001:db8:1::a").ok], [true, true]);
  assert.deepEqual([by("A", "2001:db8:2::c", 1).error, by("A", "2001:db8:2::c", 1).from], ["time exceeded", "2001:db8:1::1"]);
  assert.equal(by("A", "2001:db8:3::1").error, "no route");        // answered by the router
  assert.equal(by("C", "2001:db8:3::1").error, "no route");        // C has no route at all
  const dead = out.find(o => o.action.dst === "2001:db8:2::99");
  assert.equal(dead.frames["R:eth1>C:eth0"], 3);                   // three solicitations, then "address unreachable" to A
  assert.equal(dead.frames["R:eth0>SW:p3"], 2);                   // the NA for A, then the error
});

test("each action reports the ICMPv6 message types sent on every cable direction, in the order sent (NS 135, NA 136, echo 128/129)", () => {
  const [r] = runActions(lab(), [{do: "ping", src: "A", dst: "2001:db8:1::b"}]);
  assert.deepEqual(r.icmp6["A:eth0>SW:p1"], [135, 128]);
  assert.deepEqual(r.icmp6["B:eth0>SW:p2"], [136, 129]);
  assert.deepEqual(r.icmp6["SW:p2>B:eth0"], [135, 128]);   // the switch floods the solicitation; the echo follows
});

test("a router solicits from its link-local address, so the host solicits the router back before replying (Linux ndisc_solicit)", () => {
  const [r] = runActions(lab(), [{do: "ping", src: "A", dst: "2001:db8:2::c"}]);
  assert.deepEqual(r.icmp6["R:eth1>C:eth0"], [135, 128, 136]);   // NS for C, the forwarded echo, and the NA for C's own solicitation
  assert.deepEqual(r.icmp6["C:eth0>R:eth1"], [136, 135, 129]);   // NA, the reply, and C's solicitation for the gateway
  assert.deepEqual(r.icmp6["A:eth0>SW:p1"], [135, 128]);         // on A's own link nothing extra: A's solicitation came from its global address
});
