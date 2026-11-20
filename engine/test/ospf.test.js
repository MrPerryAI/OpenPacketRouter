import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {Network, ping, validateSpec} from "../src/index.js";

// The validator's specs (they carry an `.net` extension so the CLI's round-trip test, which reads every *.json, leaves them alone).
const load = n => JSON.parse(fs.readFileSync(new URL(`../../validate/ospf/${n}.net`, import.meta.url)));
const at = (net, t) => { net.run(t); if (net.time < t) net.time = t; };
const nbrs = (net, r) => net.node(r).ospf.neighbors().map(n => `${n.routerId} ${n.state}/${n.role}`);
const roles = (net, r) => net.node(r).ospf.interfaces().map(i => `${i.iface} ${i.state} dr=${i.dr} bdr=${i.bdr}`);
const routes = (net, r) => net.node(r).ospf.describe().map(x => `${x.network} cost ${x.cost} via ${x.via.map(v => v.gw).join(",")}`);

test("ospf specs pass the spec check without warnings", () => {
  for (const n of ["ospf-p2p", "ospf-lan", "ospf-priority", "ospf-mixed"]) {
    const v = validateSpec(load(n));
    assert.ok(v.ok, JSON.stringify(v.errors)); assert.deepEqual(v.warnings, []);
  }
});

test("the spec check catches bad ospf settings", () => {
  const s = load("ospf-p2p");
  s.nodes[0].ospf = {routerId: "1.1.1", networks: ["eth9", "10.0.0.0/33"], passive: ["eth7"], interfaces: {eth7: {}, eth0: {type: "ring", priority: 300, hello: 5, dead: 5, cost: 0, bogus: 1}}, area: 1};
  const paths = validateSpec(s).errors.map(e => e.path);
  for (const p of ["routerId", "networks[0]", "networks[1]", "passive", "interfaces.eth7", "interfaces.eth0.type", "interfaces.eth0.priority", "interfaces.eth0.cost", "interfaces.eth0.bogus", "interfaces.eth0.dead", "area"])
    assert.ok(paths.includes(`$.nodes[0].ospf.${p}`), p);
});

test("point-to-point triangle: all adjacencies Full, SPF picks the cheaper two-hop path, pings get through", () => {
  const net = Network.fromSpec(load("ospf-p2p"));
  at(net, 22);
  assert.deepEqual(nbrs(net, "R1"), ["2.2.2.2 Full/-", "3.3.3.3 Full/-"]);
  assert.deepEqual(routes(net, "R1"), ["10.3.0.0/24 cost 30 via 10.12.0.2", "10.23.0.0/24 cost 20 via 10.12.0.2"]);
  assert.deepEqual(routes(net, "R3"), ["10.1.0.0/24 cost 30 via 10.23.0.2", "10.12.0.0/24 cost 20 via 10.23.0.2"]);
  assert.equal(ping(net, "H1", "10.3.0.10").ok, true);
  assert.deepEqual(net.node("R1").ospf.interfaces().map(i => i.state), ["Point-To-Point", "Point-To-Point", "DR"]);
});

test("every router ends up with the same link state database", () => {
  const net = Network.fromSpec(load("ospf-lan"));
  at(net, 22);
  const dbs = ["R1", "R2", "R3"].map(r => net.node(r).ospf.database().map(l => `${l.type} ${l.id} ${l.adv} seq ${l.seq}`));
  assert.deepEqual(dbs[0], dbs[1]); assert.deepEqual(dbs[1], dbs[2]);
  assert.equal(dbs[0].length, 4);                                    // three router LSAs + one network LSA (from the DR)
  const net_ = net.node("R1").ospf.database().find(l => l.type === "network");
  assert.deepEqual([net_.id, net_.adv, net_.mask, net_.attached], ["10.0.0.3", "3.3.3.3", "255.255.255.0", ["1.1.1.1", "2.2.2.2", "3.3.3.3"]]);
});

test("broadcast LAN: highest router ID is DR, next is BDR, the rest DROther", () => {
  const net = Network.fromSpec(load("ospf-lan"));
  at(net, 22);
  assert.deepEqual(roles(net, "R3").slice(0, 1), ["eth0 DR dr=10.0.0.3 bdr=10.0.0.2"]);
  assert.deepEqual(roles(net, "R2"), ["eth0 Backup dr=10.0.0.3 bdr=10.0.0.2"]);
  assert.deepEqual(roles(net, "R1").slice(0, 1), ["eth0 DROther dr=10.0.0.3 bdr=10.0.0.2"]);
  assert.deepEqual(nbrs(net, "R1"), ["2.2.2.2 Full/Backup", "3.3.3.3 Full/DR"]);
  assert.equal(ping(net, "H1", "10.3.0.10").ok, true);
});

test("a DR election waits for the dead interval; the DR is alone on its host LAN", () => {
  const net = Network.fromSpec(load("ospf-lan"));
  at(net, 2);
  assert.deepEqual(net.node("R1").ospf.interfaces().map(i => i.state), ["Waiting", "Waiting"]);
  at(net, 5);
  assert.deepEqual(net.node("R1").ospf.interfaces().map(i => i.state), ["DROther", "DR"]);
});

test("priority beats router ID; priority 0 never becomes DR or BDR", () => {
  const net = Network.fromSpec(load("ospf-priority"));
  at(net, 22);
  assert.deepEqual(roles(net, "R1").slice(0, 1), ["eth0 DR dr=10.0.0.1 bdr=10.0.0.2"]);
  assert.deepEqual(roles(net, "R3").slice(0, 1), ["eth0 DROther dr=10.0.0.1 bdr=10.0.0.2"]);
});

test("DR cable cut: the BDR takes over, and the old DR does not take the job back (no preemption)", () => {
  const net = Network.fromSpec(load("ospf-lan"));
  at(net, 22); net.setLink("SW:p3", false); at(net, 47);
  assert.deepEqual(nbrs(net, "R1"), ["2.2.2.2 Full/DR"]);
  assert.deepEqual(roles(net, "R2"), ["eth0 DR dr=10.0.0.2 bdr=10.0.0.1"]);
  assert.deepEqual(nbrs(net, "R3"), []);
  assert.equal(ping(net, "H1", "10.3.0.10").ok, false);                          // R3's LAN is unreachable: no route
  net.setLink("SW:p3", true); at(net, 72);
  assert.deepEqual(roles(net, "R2"), ["eth0 DR dr=10.0.0.2 bdr=10.0.0.1"]);
  assert.deepEqual(roles(net, "R3").slice(0, 1), ["eth0 DROther dr=10.0.0.2 bdr=10.0.0.1"]);
  assert.equal(ping(net, "H1", "10.3.0.10").ok, true);
});

test("a cut link: neighbors die after the dead interval, SPF reroutes, the route returns on repair", () => {
  const net = Network.fromSpec(load("ospf-p2p"));
  at(net, 22); net.setLink("R1:eth0", false); at(net, 47);
  assert.deepEqual(nbrs(net, "R1"), ["3.3.3.3 Full/-"]);
  assert.deepEqual(routes(net, "R1"), ["10.3.0.0/24 cost 60 via 10.13.0.3", "10.23.0.0/24 cost 60 via 10.13.0.3"]);
  assert.equal(ping(net, "H1", "10.3.0.10").ok, true);
  net.setLink("R1:eth0", true); at(net, 72);
  assert.deepEqual(routes(net, "R1"), ["10.3.0.0/24 cost 30 via 10.12.0.2", "10.23.0.0/24 cost 20 via 10.12.0.2"]);
});

test("OSPF packets: protocol 89, TTL 1, multicast to 224.0.0.5 for hellos, hello fields", () => {
  const net = Network.fromSpec(load("ospf-lan")); const seen = [];
  net.taps.add((n, i, f) => { if (f.ip?.ospf) seen.push({cable: `${n.name}:${i}`, f}); });
  at(net, 22);
  const h = seen.filter(p => p.cable === "R2:eth0" && p.f.ip.ospf.type === "hello").at(-1).f;
  assert.equal(h.dst, "01:00:5e:00:00:05"); assert.equal(h.ip.dst, "224.0.0.5"); assert.equal(h.ip.ttl, 1); assert.equal(h.ip.proto, "ospf");
  assert.deepEqual([h.ip.ospf.routerId, h.ip.ospf.dr, h.ip.ospf.bdr, h.ip.ospf.priority, h.ip.ospf.helloInterval, h.ip.ospf.deadInterval], ["2.2.2.2", "10.0.0.3", "10.0.0.2", 1, 1, 4]);
  assert.deepEqual(h.ip.ospf.neighbors.slice().sort(), ["1.1.1.1", "3.3.3.3"]);
  const types = new Set(seen.map(p => p.f.ip.ospf.type));
  for (const t of ["hello", "dd", "lsr", "lsu", "ack"]) assert.ok(types.has(t), t);
  // database exchange packets between routers on a LAN are unicast to the neighbor
  assert.ok(seen.some(p => p.f.ip.ospf.type === "dd" && p.f.ip.dst !== "224.0.0.5" && p.f.ip.dst !== "224.0.0.6"));
});

test("a hello with different timers or a different mask is not accepted", () => {
  const s = load("ospf-p2p");
  s.nodes[1].ospf.interfaces.eth0.hello = 2; s.nodes[1].ospf.interfaces.eth0.dead = 8;
  const net = Network.fromSpec(s);
  at(net, 20);
  assert.deepEqual(nbrs(net, "R1"), ["3.3.3.3 Full/-"]);
  assert.ok(net.trace.some(t => t.event === "ospf-drop" && /timers 2\/8/.test(t.detail)));
});

test("a router without ospf ignores OSPF multicast; hosts are not routers", () => {
  const s = load("ospf-lan");
  delete s.nodes.find(n => n.name === "R3").ospf;
  const net = Network.fromSpec(s);
  at(net, 22);
  assert.deepEqual(nbrs(net, "R1"), ["2.2.2.2 Full/DR"]);
  assert.deepEqual(roles(net, "R2")[0], "eth0 DR dr=10.0.0.2 bdr=10.0.0.1");
});

test("passive interfaces: their subnet is advertised, but they send and accept no OSPF packets", () => {
  const net = Network.fromSpec(load("ospf-p2p")); const seen = [];
  net.taps.add((n, i, f) => { if (f.ip?.ospf) seen.push(`${n.name}:${i}`); });
  at(net, 22);
  assert.ok(!seen.includes("R1:eth2") && !seen.includes("R3:eth2"));
  const i = net.node("R1").ospf.interfaces().find(x => x.iface === "eth2");
  assert.deepEqual([i.passive, i.state, i.dr], [true, "DR", "10.1.0.1"]);       // a lone broadcast interface elects itself at once
  assert.ok(routes(net, "R3").includes("10.1.0.0/24 cost 30 via 10.23.0.2"));   // R1's passive LAN is in everyone's table
  assert.equal(ping(net, "H1", "10.3.0.10").ok, true);
});

test("a passive interface drops a hello that arrives on it", () => {
  const s = load("ospf-lan");
  s.nodes.find(n => n.name === "R1").ospf.passive = ["eth0"];       // R1's LAN port is passive: it forms no adjacencies
  const net = Network.fromSpec(s);
  at(net, 22);
  assert.deepEqual(nbrs(net, "R1"), []);
  assert.ok(net.trace.some(t => t.node === "R1" && t.event === "ospf-drop" && /passive/.test(t.detail)));
  assert.deepEqual(nbrs(net, "R2"), ["3.3.3.3 Full/DR"]);
});

test("LSAs flood across several routers: point-to-point, then a LAN, then point-to-point again", () => {
  const net = Network.fromSpec(load("ospf-mixed"));
  at(net, 22);
  const dbs = ["R1", "R2", "R3", "R4", "R5"].map(r => net.node(r).ospf.database().map(l => `${l.type} ${l.id} ${l.adv} seq ${l.seq}`).join("|"));
  for (const d of dbs) assert.equal(d, dbs[0]);
  assert.equal(net.node("R1").ospf.database().length, 6);                         // five router LSAs + the LAN's network LSA
  assert.deepEqual(routes(net, "R1"), ["10.0.0.0/24 cost 25 via 10.12.0.2", "10.5.0.0/24 cost 42 via 10.12.0.2", "10.45.0.0/24 cost 32 via 10.12.0.2"]);
  assert.equal(ping(net, "H1", "10.5.0.10").ok, true);
});
