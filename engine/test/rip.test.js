import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {Network, ping, runActions, validateSpec} from "../src/index.js";

const load = n => JSON.parse(fs.readFileSync(new URL(`../../validate/rip/${n}.json`, import.meta.url)));
const at = (net, t) => { net.run(t); if (net.time < t) net.time = t; };
const table = (net, r) => net.node(r).rip.describe().map(x => `${x.type} ${x.network}${x.type === "R" ? " via " + x.nextHop : ""} ${x.metric}`);
const route = (net, r, cidr) => net.node(r).rip.table.get(cidr);

test("rip specs pass the spec check without warnings", () => {
  for (const n of ["rip-chain", "rip-lan", "rip-nosplit", "count-to-infinity"]) {
    const v = validateSpec(load(n));
    assert.ok(v.ok, JSON.stringify(v.errors)); assert.deepEqual(v.warnings, []);
  }
});

test("the spec check catches bad rip settings", () => {
  const s = load("rip-chain");
  s.nodes[1].rip = {networks: ["eth9", "10.0.0.0/33"], passive: ["eth7"], splitHorizon: "sometimes", timers: {update: 0, hello: 2}, triggered: "yes"};
  const paths = validateSpec(s).errors.map(e => e.path);
  for (const p of ["networks[0]", "networks[1]", "passive", "splitHorizon", "timers.update", "timers.hello", "triggered"])
    assert.ok(paths.includes(`$.nodes[1].rip.${p}`), p);
});

test("chain converges: metrics count hops, next hops point at the neighbour, pings get through", () => {
  const net = Network.fromSpec(load("rip-chain"));
  at(net, 14);
  assert.deepEqual(table(net, "R1"), ["C 10.0.12.0/30 1", "R 10.0.23.0/30 via 10.0.12.2 2", "C 10.1.0.0/24 1", "R 10.3.0.0/24 via 10.0.12.2 3"]);
  assert.deepEqual(table(net, "R3"), ["R 10.0.12.0/30 via 10.0.23.1 2", "C 10.0.23.0/30 1", "R 10.1.0.0/24 via 10.0.23.1 3", "C 10.3.0.0/24 1"]);
  assert.equal(ping(net, "H1", "10.3.0.10").ok, true);
});

test("updates: multicast, TTL 1, poisoned reverse, passive interfaces stay quiet", () => {
  const net = Network.fromSpec(load("rip-chain")); const seen = [];
  net.taps.add((n, i, f) => { const cable = `${n.name}:${i}>${n.ifaces[i].peer.node.name}:${n.ifaces[i].peer.name}`; if (f.ip?.udp?.payload?.rip) seen.push({cable, f}); });
  at(net, 14);
  const last = cable => seen.filter(p => p.cable === cable && p.f.ip.dst === "224.0.0.9" && p.f.ip.udp.payload.rip.command === "response").at(-1).f;
  const f = last("R2:eth0>R1:eth1");
  assert.equal(f.dst, "01:00:5e:00:00:09"); assert.equal(f.ip.ttl, 1); assert.equal(f.ip.udp.sport, 520);
  // R2 → R1: R1's own subnets come back poisoned, with R1 named as next hop; R3's side at its real metric
  assert.deepEqual(f.ip.udp.payload.rip.entries.map(e => `${e.net} ${e.nextHop} ${e.metric}`),
    ["10.0.12.0 0.0.0.0 16", "10.0.23.0 0.0.0.0 1", "10.1.0.0 10.0.12.1 16", "10.3.0.0 0.0.0.0 2"]);
  // R1's host LAN is passive: no updates there (like FRR, it still asks once for routes when it comes up)
  assert.deepEqual(seen.filter(p => p.cable === "R1:eth0>H1:eth0").map(p => p.f.ip.udp.payload.rip.command), ["request"]);
  assert.ok(seen.some(p => p.cable === "R3:eth1>H3:eth0"), "R3 sends to its host LAN");
});

test("simple split horizon leaves routes out instead of poisoning them", () => {
  const net = Network.fromSpec(load("rip-lan")); at(net, 14);
  assert.deepEqual(net.node("R1").rip.entries("eth0").map(e => `${e.net}/${e.mask} ${e.metric}`), ["10.1.0.0/255.255.255.0 1"]);
  assert.deepEqual(net.node("R1").rip.entries("eth1").map(e => `${e.net} ${e.metric}`), ["10.0.0.0 1", "10.2.0.0 2", "10.3.0.0 2"]);
});

test("carrier loss: metric 16 at once on both sides, triggered updates spread it, garbage collection deletes", () => {
  const net = Network.fromSpec(load("rip-chain")); at(net, 14);
  net.setLink("R2:eth1", false); at(net, 14.1);
  assert.equal(route(net, "R1", "10.3.0.0/24").metric, 16);                 // two hops away, 100 ms later: triggered
  assert.equal(ping(net, "H1", "10.3.0.10").error, "net unreachable");
  at(net, 26);
  assert.equal(route(net, "R1", "10.3.0.0/24"), undefined);
  assert.deepEqual(table(net, "R3"), ["C 10.3.0.0/24 1"]);
  net.setLink("R2:eth1", true); at(net, 40);
  assert.equal(route(net, "R1", "10.3.0.0/24").metric, 3);
});

test("silent neighbour: routes time out after `timeout` s, then are deleted `garbage` s later", () => {
  const net = Network.fromSpec(load("rip-lan")); at(net, 14);
  net.setLink("SW:p3", false);                                               // R1 and R2 keep carrier
  const lastHeard = 12;                                                      // R3's last update (2, 7, 12, ...)
  at(net, lastHeard + 14.9); assert.equal(route(net, "R1", "10.3.0.0/24").metric, 2);
  at(net, lastHeard + 15.1); assert.equal(route(net, "R1", "10.3.0.0/24").metric, 16);
  at(net, lastHeard + 25.1); assert.equal(route(net, "R1", "10.3.0.0/24"), undefined);
  assert.equal(route(net, "R1", "10.2.0.0/24").metric, 2);                   // R2 is still there
});

test("without split horizon the next-hop field still stops a two-router loop", () => {
  const net = Network.fromSpec(load("rip-nosplit")); at(net, 14);
  net.setLink("H2:eth0", false); at(net, 18);
  assert.equal(route(net, "R1", "10.2.0.0/24").metric, 16);
  assert.equal(route(net, "R2", "10.2.0.0/24").metric, 16);
});

test("count to infinity: a loop of three counts to 16 when triggered updates are off", () => {
  const spec = load("count-to-infinity");
  const res = runActions(spec, JSON.parse(fs.readFileSync(new URL("../../validate/rip/count-to-infinity.actions.json", import.meta.url))));
  const metrics = res.filter(r => r.action.do === "ripRoute").map(r => Object.values(r.result.routers).filter(x => x && x.type === "R" && x.metric < 16).map(x => x.metric));
  const seen = [...new Set(metrics.flat())];
  for (let m = 3; m <= 15; m++) assert.ok(seen.includes(m), `metric ${m} appears while counting`);
  assert.deepEqual(metrics.at(-1), []);                                       // and in the end nobody has a route
  // the same network with triggered updates on: no count
  for (const n of spec.nodes) if (n.rip) n.rip.triggered = true;
  const net = Network.fromSpec(spec); at(net, 14); net.setLink("H3:eth0", false); at(net, 40);
  for (const r of ["R1", "R2", "R3"]) assert.ok(!route(net, r, "10.3.0.0/24") || route(net, r, "10.3.0.0/24").metric === 16, r);
});
