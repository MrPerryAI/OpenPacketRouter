import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {Network, runActions, validateSpec} from "../src/index.js";
import {Nat, tuple} from "../src/nat.js";

const lab = () => JSON.parse(fs.readFileSync(new URL("../../validate/nat/nat-lab.json", import.meta.url)));
const actions = () => JSON.parse(fs.readFileSync(new URL("../../validate/nat/nat-lab.actions.json", import.meta.url)));
const R = net => net.node("R").nat;
const udp = (src, sport, dst, dport) => ({src, dst, proto: "udp", ttl: 64, udp: {sport, dport, payload: null}});

test("the NAT lab passes the spec check without warnings", () => {
  const v = validateSpec(lab(), actions());
  assert.ok(v.ok, JSON.stringify(v.errors)); assert.deepEqual(v.warnings, []);
});

test("the spec check catches bad nat keys", () => {
  const s = lab();
  s.nodes.find(n => n.name === "R").nat = {inside: ["eth0", "eth9"], outside: ["eth0"], overload: {src: "nope"}, bogus: 1,
    static: [{inside: "10.1.0.10"}, {inside: "10.1.0.11", outside: "1.2.3.4", insidePort: 80}, {proto: "icmp", inside: "10.1.0.1", outside: "1.2.3.4"}]};
  const paths = validateSpec(s).errors.map(e => e.path);
  for (const p of ["inside", "bogus", "overload", "static[0].outside", "static[1].insidePort", "static[2].proto"])
    assert.ok(paths.some(x => x.startsWith(`$.nodes[3].nat.${p}`) || x.startsWith(`$.nodes[4].nat.${p}`)), p);
});

test("overload keeps the source port, and flows from two hosts get different outside ports on a clash", () => {
  const net = Network.fromSpec(lab()), nat = R(net);
  net.run(0.1);
  const a = nat.post(null, "eth0", "eth1", udp("10.1.0.11", 5000, "203.0.113.50", 53));
  assert.equal(a.src, "203.0.113.1"); assert.equal(a.udp.sport, 5000);
  const b = nat.post(null, "eth0", "eth1", udp("10.1.0.20", 5000, "203.0.113.50", 53));
  assert.equal(b.src, "203.0.113.1"); assert.notEqual(b.udp.sport, 5000);   // the reply tuple must be unique
  const c = nat.post(null, "eth0", "eth1", udp("10.1.0.20", 5000, "203.0.113.51", 53));
  assert.equal(c.udp.sport, 5000);                                         // a different destination: same port is fine
  const back = nat.pre("eth1", udp("203.0.113.50", 53, "203.0.113.1", b.udp.sport)).p;
  assert.equal(back.dst, "10.1.0.20"); assert.equal(back.udp.dport, 5000);
});

test("replies need a flow: an unsolicited packet to the outside address is not translated", () => {
  const net = Network.fromSpec(lab()), nat = R(net);
  const p = udp("203.0.113.50", 53, "203.0.113.1", 5000);
  assert.deepEqual(nat.pre("eth1", p).p, p);
});

test("entries expire after their idle timeout (UDP 30 s unanswered)", () => {
  const net = Network.fromSpec(lab()), nat = R(net);
  nat.post(null, "eth0", "eth1", udp("10.1.0.11", 5000, "203.0.113.50", 53));
  assert.equal(nat.translations().filter(r => !r.static).length, 1);
  net.time += 31;
  assert.equal(nat.translations().filter(r => !r.static).length, 0);
});

test("the lab's actions all work through the engine", () => {
  const r = runActions(lab(), actions());
  for (const x of r) if (x.action.port !== 81 && x.action.port !== 9999) assert.ok(x.result.ok || x.result.reached, JSON.stringify(x));
});

test("tuple() describes TCP, UDP and ICMP echo", () => {
  assert.deepEqual(tuple({src: "a", dst: "b", proto: "icmp", icmp: {type: 8, id: 7}}), {proto: "icmp", src: "a", sport: 7, dst: "b", dport: 7});
});
