// BGP commands: configure, running-config round trip on the validation networks, FRR rendering, show ip bgp, routes in show ip route.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createSession} from "../src/index.js";
import {engineBackend} from "../src/backends/engine.js";
import {frrConfig} from "../src/backends/frr.js";
import {ROOT, blankDevice} from "./helpers.js";

const load = n => JSON.parse(fs.readFileSync(path.join(ROOT, "validate/bgp", `${n}.net`), "utf8"));
const NETS = ["bgp-chain", "bgp-ibgp", "bgp-paths", "bgp-localpref"];

for (const name of NETS) test(`round trip: validate/bgp/${name}`, () => {
  const spec = load(name);
  for (const node of spec.nodes) {
    const text = createSession(engineBackend(spec), node.name, {mode: "priv"}).exec("show running-config").output;
    const b = engineBackend(blankDevice(spec, node.name));
    const r = createSession(b, "NEW", {mode: "config"});
    for (const line of text.split("\n")) {
      if (/^\s*(!|end$)/.test(line)) continue;
      const out = r.exec(line.trim());
      assert.ok(!out.output.startsWith("%") && !out.output.includes("\n%"), `${name} ${node.name}: "${line.trim()}" -> ${out.output}`);
    }
    assert.deepEqual(b.spec().nodes.find(n => n.name === node.name), node, `${name} ${node.name}\n${text}`);
    assert.equal(createSession(b, node.name, {mode: "priv"}).exec("show running-config").output, text);
  }
});

test("configure BGP by hand, then read it back", () => {
  const spec = {format: "openpacketrouter.spec/1", name: "x", nodes: [{name: "R", kind: "router", ifaces: {eth0: "10.0.0.1/24"}}], links: []};
  const b = engineBackend(spec), s = createSession(b, "R", {mode: "config"});
  for (const l of ["router bgp 65001", "bgp router-id 1.1.1.1", "neighbor 10.0.0.2 remote-as 65002", "neighbor 10.0.0.2 next-hop-self", "neighbor 10.0.0.2 local-preference 200",
    "network 10.1.0.0/24", "timers bgp 1 3", "timers connect 5"]) assert.ok(!s.exec(l).output.startsWith("%"), l);
  assert.equal(s.prompt(), "R(config-router)#");
  assert.deepEqual(b.spec().nodes[0].bgp, {asn: 65001, routerId: "1.1.1.1", networks: ["10.1.0.0/24"], timers: {keepalive: 1, hold: 3, connect: 5},
    neighbors: [{ip: "10.0.0.2", remoteAs: 65002, nextHopSelf: true, localPref: 200}]});
  assert.match(s.exec("neighbor 10.0.0.9 next-hop-self").output, /^%.*No BGP neighbor/);
  assert.match(s.exec("timers bgp 1 2").output, /^%.*at least 3/);
  s.exec("no neighbor 10.0.0.2"); s.exec("no network 10.1.0.0/24"); s.exec("no timers bgp"); s.exec("no timers connect");
  assert.deepEqual(b.spec().nodes[0].bgp, undefined);   // no neighbors left: the engine has nothing to run
  s.exec("exit"); assert.ok(!s.exec("no router bgp").output.startsWith("%"));
});

test("FRR rendering: router bgp, address family, route-map for the local preference", () => {
  const f = frrConfig(engineBackend(load("bgp-localpref")).getConfig("R4"));
  assert.match(f, /router bgp 65004\n bgp router-id 4\.4\.4\.4\n no bgp ebgp-requires-policy\n timers bgp 1 3\n neighbor 10\.24\.0\.2 remote-as 65002\n neighbor 10\.24\.0\.2 timers connect 5\n/);
  assert.match(f, / address-family ipv4 unicast\n  network 10\.4\.0\.0\/24\n  neighbor 10\.45\.0\.5 route-map LP200 in\n exit-address-family\nexit\nroute-map LP200 permit 10\n set local-preference 200\nexit/);
  assert.match(frrConfig(engineBackend(load("bgp-ibgp")).getConfig("R2")), /  neighbor 10\.12\.0\.1 next-hop-self/);
});

test("show ip bgp, show ip bgp summary and BGP routes in show ip route", () => {
  const s = createSession(engineBackend(load("bgp-paths")), "R4", {mode: "priv"});
  const rows = s.exec("show ip bgp | json").json;
  const best = rows.filter(r => r.prefix === "10.1.0.0/24");
  assert.deepEqual(best.map(r => [r.status, r.nextHop, r.asPath]), [["best", "10.24.0.2", "65002 65001"], ["valid", "10.45.0.5", "65005 65003 65001"]]);
  assert.match(s.exec("show ip bgp").output, /^\*> +10\.1\.0\.0\/24 +10\.24\.0\.2 +100 +65002 65001 i$/m);
  const sum = s.exec("show ip bgp summary | json").json;
  assert.deepEqual(sum.neighbors.map(n => [n.neighbor, n.remoteAs, n.state]), [["10.24.0.2", 65002, "Established"], ["10.45.0.5", 65005, "Established"]]);
  assert.match(s.exec("show ip bgp summary").output, /local AS number 65004/);
  const r = s.exec("show ip route | json").json.find(x => x.prefix === "10.1.0.0/24");
  assert.deepEqual([r.protocol, r.nextHop, r.interface], ["bgp", "10.24.0.2", "eth0"]);
  assert.match(s.exec("show ip route").output, /^B  10\.1\.0\.0\/24 via 10\.24\.0\.2, out eth0/m);
  const none = createSession(engineBackend({format: "openpacketrouter.spec/1", name: "x", nodes: [{name: "R", kind: "router", ifaces: {eth0: "10.0.0.1/24"}}], links: []}), "R", {mode: "priv"});
  assert.match(none.exec("show ip bgp").output, /not running/);
});
