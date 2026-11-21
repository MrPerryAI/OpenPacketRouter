import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {Network, runActions, validateSpec} from "../src/index.js";
import {Acl} from "../src/acl.js";

const lab = () => JSON.parse(fs.readFileSync(new URL("../../validate/acl/acl-lab.json", import.meta.url)));
const actions = () => JSON.parse(fs.readFileSync(new URL("../../validate/acl/acl-lab.actions.json", import.meta.url)));
const pkt = (proto, extra = {}, src = "10.1.0.10", dst = "10.2.0.10") => ({src, dst, proto, ttl: 64, ...extra});

test("the access-list lab passes the spec check without warnings", () => {
  const v = validateSpec(lab(), actions());
  assert.ok(v.ok, JSON.stringify(v.errors)); assert.deepEqual(v.warnings, []);
});

test("the spec check catches bad access lists", () => {
  const s = lab();
  s.nodes[1].acl = {lists: {L: [{action: "allow"}, {action: "permit", proto: "icmp", dport: 80}, {action: "deny", src: "10.0.0.0/33"},
    {action: "permit", proto: "tcp", dport: "90-80", icmpType: 8}, {action: "permit", bogus: 1}]}, bind: {eth9: {in: "L"}, eth0: {in: "NOPE", sideways: "L"}}};
  const paths = validateSpec(s).errors.map(e => e.path);
  for (const p of ["lists.L[0].action", "lists.L[1].dport", "lists.L[2].src", "lists.L[3].dport", "lists.L[3].icmpType", "lists.L[4].bogus", "bind.eth9", "bind.eth0.in", "bind.eth0.sideways"])
    assert.ok(paths.includes(`$.nodes[1].acl.${p}`), p);
});

test("rules: first match wins, implicit deny, ports, prefixes, established, ICMP type", () => {
  const a = new Acl({lists: {L: [
    {action: "deny", proto: "tcp", src: "10.1.0.66", dport: 80},
    {action: "permit", proto: "tcp", src: "10.1.0.0/24", dport: "80-90"},
    {action: "permit", proto: "tcp", established: true},
    {action: "permit", proto: "icmp", icmpType: 8}]}, bind: {eth0: {in: "L"}}});
  const tcp = (src, dport, flags = "S") => pkt("tcp", {tcp: {sport: 5000, dport, flags}}, src);
  const c = p => a.check("in", "eth0", p);
  assert.deepEqual([c(tcp("10.1.0.66", 80)).permit, c(tcp("10.1.0.66", 80)).rule], [false, 0]);
  assert.deepEqual([c(tcp("10.1.0.7", 85)).permit, c(tcp("10.1.0.7", 85)).rule], [true, 1]);
  assert.equal(c(tcp("10.1.0.7", 91)).rule, -1);                          // nothing matches: implicit deny
  assert.equal(c(tcp("10.9.9.9", 91, "A")).rule, 2);                     // established: ACK set
  assert.equal(c(tcp("10.9.9.9", 91, "S")).permit, false);               // a bare SYN is not established
  assert.equal(c(pkt("icmp", {icmp: {type: 8}})).permit, true);
  assert.equal(c(pkt("icmp", {icmp: {type: 0}})).permit, false);
  assert.equal(a.check("out", "eth0", tcp("10.1.0.7", 1)).permit, true);  // no list bound that way
  assert.equal(c(pkt("udp", {udp: {sport: 1, dport: 2}}, "10.1.0.1", "224.0.0.9")).permit, true);   // multicast is never filtered
});

test("lab: results match what the lists say (the Linux nftables run compares frames)", () => {
  const res = runActions(lab(), actions());
  const out = res.map(e => e.action.do === "traceroute" ? (e.result.reached ? "reached" : "not reached") : e.result.ok ? "ok" : e.result.error + (e.result.from ? " from " + e.result.from : ""));
  assert.deepEqual(out, ["ok", "ok", "timeout", "administratively prohibited from 10.1.0.1", "administratively prohibited from 10.1.0.1",
    "administratively prohibited from 10.1.0.1", "timeout", "administratively prohibited from 10.2.0.1", "reached",
    "ok", "os error 113", "os error 113"]);
});

test("a denied packet is logged with the list, direction and rule", () => {
  const log = actionTrace([{do: "udp", src: "A", dst: "10.2.0.10", port: 9000}]);
  assert.ok(log.some(d => /TO-SERVERS out on eth1 denied by rule 1/.test(d)), log.join("\n"));
  const log2 = actionTrace([{do: "udp", src: "A", dst: "10.2.0.10", port: 5000}]);
  assert.ok(log2.some(d => /FROM-LAN in on eth0 implicit deny/.test(d)), log2.join("\n"));
});

function actionTrace(acts) { return runActions(lab(), acts, {trace: true})[0].trace.map(t => t.detail); }
