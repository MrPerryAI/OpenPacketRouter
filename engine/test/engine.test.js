import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {Network, ping, traceroute, dns, udpRequest} from "../src/index.js";

const spec = name => JSON.parse(fs.readFileSync(new URL(`../../validate/l3/${name}.json`, import.meta.url)));

function lan() {
  const net = new Network();
  net.addSwitch("SW");
  net.addHost("A", {ifaces: {eth0: "10.0.0.1/24"}});
  net.addHost("B", {ifaces: {eth0: "10.0.0.2/24"}});
  net.addHost("C", {ifaces: {eth0: "10.0.0.3/24"}});
  net.link("A:eth0", "SW:p1"); net.link("B:eth0", "SW:p2"); net.link("C:eth0", "SW:p3");
  return net;
}

test("ping on one LAN: ARP broadcast is flooded, everything else goes straight to its port", () => {
  const net = lan();
  // 8 ms: the first ping waits for ARP (4 cable crossings) before its own 4 crossings
  assert.deepEqual(ping(net, "A", "10.0.0.2"), {ok: true, from: "10.0.0.2", rtt_ms: 8});
  net.settle();
  // A: ARP request + echo. SW floods the request to B and C, then forwards the reply and echo directly.
  assert.equal(net.counters.get("SW:p3>C:eth0"), 1, "C only hears the broadcast");
  assert.equal(net.counters.get("A:eth0>SW:p1"), 2);
  assert.equal(net.counters.get("SW:p2>B:eth0"), 2);
});

test("a learning switch stops flooding once it knows where a MAC lives", () => {
  const net = lan();
  ping(net, "A", "10.0.0.2"); net.settle();
  const before = net.snapshot();
  ping(net, "A", "10.0.0.2"); net.settle();
  assert.equal(net.diff(before)["SW:p3>C:eth0"], undefined, "C hears nothing the second time");
});

test("routed network: ping across three routers, traceroute lists each router", () => {
  const net = Network.fromSpec(spec("fti-routed"));
  assert.equal(ping(net, "ZFW-VOICE", "172.16.20.10").ok, true);
  const t = traceroute(net, "ZFW-VOICE", "172.16.20.10");
  assert.deepEqual(t.hops.map(h => h.from), ["10.1.0.1", "10.255.1.1", "10.255.2.2", "10.255.3.2", "172.16.20.10"]);
});

test("DNS server answers; unknown names get null; the client's socket doesn't bounce the answer", () => {
  const net = Network.fromSpec(spec("fti-routed"));
  assert.equal(dns(net, "ZME-VOICE", "10.0.0.53", "eld-radio.fti").answer, "172.16.20.10");
  assert.equal(dns(net, "ZME-VOICE", "10.0.0.53", "nope.fti").answer, null);
  net.settle();
  assert.ok(!net.trace.some(e => e.node === "ZME-VOICE" && e.event === "port-closed"));
});

test("UDP to a closed port gets ICMP port unreachable from the server", () => {
  const net = Network.fromSpec(spec("fti-routed"));
  assert.deepEqual(udpRequest(net, "ZME-VOICE", "172.16.20.10", 9999, {}).error, "port unreachable");
});

test("a missing host: the router tries ARP three times, then sends host unreachable", () => {
  const net = Network.fromSpec(spec("fti-routed"));
  const r = ping(net, "ZFW-VOICE", "10.2.0.99", {timeout: 5});
  assert.deepEqual([r.ok, r.from, r.error], [false, "10.255.2.2", "host unreachable"]);
  assert.equal(net.trace.filter(e => e.node === "R-ZME" && e.event === "arp-request" && e.detail.includes("10.2.0.99")).length, 3);
});

test("routing loop: the packet bounces until TTL runs out, then time exceeded comes back", () => {
  const net = Network.fromSpec(spec("fti-loop"));
  const r = ping(net, "ZFW-VOICE", "172.16.20.10");
  assert.equal(r.error, "time exceeded");
  const bounces = net.trace.filter(e => e.event === "route" && e.detail.includes("172.16.20.10")).length;
  assert.ok(bounces > 55, `bounced ${bounces} times`);
});

test("missing return route: request arrives, reply can't leave, ping times out", () => {
  const net = Network.fromSpec(spec("fti-noreturn"));
  assert.equal(ping(net, "ZFW-VOICE", "172.16.20.10").error, "timeout");
  assert.ok(net.trace.some(e => e.node === "R-ELD" && e.event === "no-route"));
});

test("deterministic: the same network and actions give the same frames", () => {
  const run = () => { const net = Network.fromSpec(spec("fti-routed")); traceroute(net, "ZFW-VOICE", "172.16.20.10"); net.settle(); return [...net.counters]; };
  assert.deepEqual(run(), run());
});

test("every routing decision is explained", () => {
  const net = Network.fromSpec(spec("fti-routed"));
  ping(net, "ZFW-VOICE", "172.16.20.10");
  const why = net.trace.find(e => e.node === "R-ZME" && e.event === "route");
  assert.match(why.detail, /route 172\.16\.20\.0\/24 via 10\.255\.3\.2/);
});
