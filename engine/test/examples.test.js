import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {spawnSync} from "node:child_process";

const CLI = new URL("../bin/openpacketrouter.mjs", import.meta.url).pathname;
const dir = new URL("../../examples/", import.meta.url).pathname;
const labs = fs.readdirSync(dir, {withFileTypes: true}).filter(d => d.isDirectory()).map(d => d.name);

function run(lab, ...flags) {
  const r = spawnSync("node", [CLI, "run", `${dir}${lab}/spec.json`, `${dir}${lab}/actions.json`, "--compact", ...flags], {encoding: "utf8"});
  assert.equal(r.status, 0, `${lab}: ${r.stderr}`);
  return JSON.parse(r.stdout).actions;
}
const total = a => Object.values(a.frames).reduce((x, y) => x + y, 0);

test("there are at least five labs, each with a README and checking clean", () => {
  assert.ok(labs.length >= 5);
  for (const l of labs) {
    assert.ok(fs.existsSync(`${dir}${l}/README.md`), `${l} README`);
    const r = spawnSync("node", [CLI, "check", `${dir}${l}/spec.json`, `${dir}${l}/actions.json`], {encoding: "utf8"});
    assert.equal(r.status, 0, `${l}: ${r.stderr}`);
    assert.equal(r.stderr, "", `${l} has warnings`);
  }
});

test("loop-no-stp: the broadcast storms and the ping fails", () => {
  const [a] = run("loop-no-stp");
  assert.equal(a.result.ok, false);
  assert.ok(total(a) > 100000);
});

test("loop-with-stp: after convergence the ping works with few frames", () => {
  const [, a] = run("loop-with-stp");
  assert.equal(a.result.ok, true);
  assert.ok(total(a) < 100);
});

test("vlans: same VLAN across the trunk works, different VLANs time out", () => {
  assert.deepEqual(run("vlans").map(a => a.result.ok), [true, true, false, false]);
});

test("dhcp-router: lease, then a routed ping", () => {
  const [d, p] = run("dhcp-router");
  assert.equal(d.result.ip, "10.0.0.100");
  assert.equal(p.result.ok, true);
});

test("bottleneck: a short burst fits, a long one drops frames", () => {
  const [s, l, p] = run("bottleneck");
  assert.deepEqual(s.drops, {});
  assert.equal(l.drops["PC:eth0"], 15);
  assert.equal(p.result.ok, true);
});

test("routed-lan-dns: ping, traceroute via R1, dns answer, unknown address fails", () => {
  const [p, t, d, bad] = run("routed-lan-dns");
  assert.equal(p.result.ok, true);
  assert.equal(t.result.hops[0].from, "10.0.0.1");
  assert.equal(d.result.answer, "10.1.0.53");
  assert.equal(bad.result.ok, false);
});

test("tcp: handshake and echo, refused, and a SYN that gets no answer", () => {
  const [ok, refused, timeout] = run("tcp");
  assert.equal(ok.result.ok, true);
  assert.equal(ok.result.bytes, 100);
  assert.equal(refused.result.error, "refused");
  assert.deepEqual(timeout.result.wire, ["out S", "out S", "out S"]);
});

test("index.json lists exactly the lab folders, with files that exist", () => {
  const idx = JSON.parse(fs.readFileSync(`${dir}index.json`));
  assert.deepEqual(idx.labs.map(l => l.id).sort(), [...labs].sort());
  for (const l of idx.labs) {
    for (const f of [l.spec, l.actions, l.readme]) assert.ok(fs.existsSync(`${dir}${f}`), `${l.id}: ${f}`);
    assert.equal(JSON.parse(fs.readFileSync(`${dir}${l.spec}`)).name, l.name);
  }
});

test("dhcp-relay: the router relays, each PC gets an address from the relayed pool", () => {
  const [a, b, p] = run("dhcp-relay");
  assert.equal(a.result.ip, "10.1.0.100");
  assert.equal(b.result.ip, "10.1.0.101");
  assert.equal(p.result.ok, true);
});

test("mac-aging: SW1 forgets after 5 s and floods; SW2 (12 s) still forwards", () => {
  const [first, t1, , t2, t3, second] = run("mac-aging");
  assert.equal(first.result.ok, true);
  assert.equal(t1.result.entries.length, 2);
  assert.equal(t2.result.entries.length, 0);        // SW1: aged out
  assert.equal(t3.result.entries.length, 2);        // SW2: still known
  assert.equal(second.frames["SW1:p2>B:eth0"], 1);  // flooded to B
  assert.equal(second.frames["SW2:p1>SW1:p3"], 1);
});

test("rip-chain: route poisoned on the cut, gone after garbage collection, back after repair", () => {
  const r = run("rip-chain");
  const m = n => r.filter(a => a.action.do === "ripRoute")[n].result.routers.R1;
  assert.equal(m(0).metric, 3); assert.equal(m(1).metric, 16); assert.equal(m(2), null); assert.equal(m(3).metric, 3);
  assert.deepEqual(r.filter(a => a.action.do === "ping").map(a => a.result.ok), [true, false, true]);
});

test("count-to-infinity: the false route outlives the cut and climbs to 16", () => {
  const ms = run("count-to-infinity").filter(a => a.action.do === "ripRoute").map(a => a.result.routers.R1?.metric);
  assert.equal(ms[0], 2); assert.ok(ms.slice(1).includes(16)); assert.ok(ms.slice(1, 4).every(m => m < 16));
});

test("--text report has no 'undefined' for any example lab", () => {
  for (const lab of labs) {
    const r = spawnSync("node", [CLI, "run", `${dir}${lab}/spec.json`, `${dir}${lab}/actions.json`, "--text"], {encoding: "utf8"});
    assert.equal(r.status, 0, `${lab}: ${r.stderr}`);
    assert.ok(!/undefined/.test(r.stdout), `${lab}: ${r.stdout.split("\n").find(l => /undefined/.test(l))}`);
  }
});
