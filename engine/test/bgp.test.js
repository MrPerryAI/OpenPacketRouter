import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {Network, ping, validateSpec} from "../src/index.js";

const load = n => JSON.parse(fs.readFileSync(new URL(`../../validate/bgp/${n}.net`, import.meta.url)));
const at = (net, t) => { net.run(t); if (net.time < t) net.time = t; };
const best = (net, r) => net.node(r).bgp.describe().filter(x => x.best).map(x => `${x.prefix} from ${x.from} path [${x.asPath}] nh ${x.nextHop}`);
const up = (net, r) => net.node(r).bgp.neighbors().map(n => `${n.ip} ${n.state}`);

test("bgp specs pass the spec check without warnings", () => {
  for (const n of ["bgp-chain", "bgp-ibgp", "bgp-paths", "bgp-localpref"]) { const v = validateSpec(load(n)); assert.ok(v.ok, JSON.stringify(v.errors)); assert.deepEqual(v.warnings, []); }
});

test("the spec check catches bad bgp settings", () => {
  const s = load("bgp-chain");
  s.nodes[0].bgp = {asn: 0, routerId: "1.1", networks: ["10.0.0.0/40"], timers: {hold: 2, bogus: 1}, neighbors: [{ip: "10.1", remoteAs: 70000, localPref: 1.5, extra: 1}], what: 1};
  const paths = validateSpec(s).errors.map(e => e.path);
  for (const p of ["asn", "routerId", "networks", "timers.hold", "timers.bogus", "neighbors[0].ip", "neighbors[0].remoteAs", "neighbors[0].localPref", "neighbors[0].extra", "what"])
    assert.ok(paths.includes(`$.nodes[0].bgp.${p}`), p);
});

test("eBGP chain: sessions come up, every AS learns every prefix with the AS path, pings cross three ASes", () => {
  const net = Network.fromSpec(load("bgp-chain"));
  at(net, 25);
  assert.deepEqual(up(net, "R2"), ["10.12.0.1 Established", "10.23.0.3 Established"]);
  assert.deepEqual(best(net, "R1"), ["10.1.0.0/24 from local path [] nh 0.0.0.0", "10.2.0.0/24 from 10.12.0.2 path [65002] nh 10.12.0.2", "10.3.0.0/24 from 10.12.0.2 path [65002 65003] nh 10.12.0.2"]);
  assert.ok(ping(net, "H1", "10.3.0.10", {timeout: 2}).ok);
  net.setLink("R2:eth1", false); at(net, 50);                                  // eBGP ends with the carrier; the far prefixes go
  assert.deepEqual(up(net, "R3"), ["10.23.0.2 Connect"]);
  assert.deepEqual(best(net, "R1"), ["10.1.0.0/24 from local path [] nh 0.0.0.0", "10.2.0.0/24 from 10.12.0.2 path [65002] nh 10.12.0.2"]);
  net.setLink("R2:eth1", true); at(net, 90);
  assert.equal(best(net, "R1").length, 3);
  assert.ok(ping(net, "H1", "10.3.0.10", {timeout: 2}).ok);
});

test("iBGP: next hop stays unless next-hop-self; an iBGP session ends on the hold timer, not on carrier loss", () => {
  const net = Network.fromSpec(load("bgp-ibgp"));
  at(net, 25);
  assert.deepEqual(best(net, "R1"), ["10.1.0.0/24 from local path [] nh 0.0.0.0", "10.3.0.0/24 from 10.12.0.2 path [65002] nh 10.12.0.2"]);   // next-hop-self on R2
  assert.deepEqual(best(net, "R2"), ["10.1.0.0/24 from 10.12.0.1 path [] nh 10.12.0.1", "10.3.0.0/24 from 10.23.0.3 path [65002] nh 10.23.0.3"]);
  net.setLink("R1:eth0", false); at(net, 26);
  assert.deepEqual(up(net, "R2"), ["10.12.0.1 Established", "10.23.0.3 Established"]);   // still up: no hold timer expiry yet
  at(net, 40);
  assert.deepEqual(up(net, "R2")[0], "10.12.0.1 Connect");
});

test("path selection: the shorter AS path wins; a higher local preference beats a shorter AS path", () => {
  const a = Network.fromSpec(load("bgp-paths")); at(a, 25);
  assert.deepEqual(best(a, "R4").filter(x => x.startsWith("10.1.")), ["10.1.0.0/24 from 10.24.0.2 path [65002 65001] nh 10.24.0.2"]);
  a.setLink("R2:eth1", false); at(a, 50);
  assert.deepEqual(best(a, "R4").filter(x => x.startsWith("10.1.")), ["10.1.0.0/24 from 10.45.0.5 path [65005 65003 65001] nh 10.45.0.5"]);
  assert.ok(ping(a, "H4", "10.1.0.10", {timeout: 2}).ok);
  const b = Network.fromSpec(load("bgp-localpref")); at(b, 25);
  assert.deepEqual(best(b, "R4").filter(x => x.startsWith("10.1.")), ["10.1.0.0/24 from 10.45.0.5 path [65005 65003 65001] nh 10.45.0.5"]);
});

test("eBGP: a route learned from a peer is also announced back to it (bgpd does; the peer drops it as a loop)", () => {
  const net = Network.fromSpec(load("bgp-chain"));
  at(net, 40);
  const sent = [...net.node("R1").bgp.peers.get("10.12.0.2").adjOut.keys()].sort();
  assert.deepEqual(sent, ["10.1.0.0/24", "10.2.0.0/24", "10.3.0.0/24"]);
  assert.ok(best(net, "R2").some(x => x.startsWith("10.2.0.0/24 from local")));
});
