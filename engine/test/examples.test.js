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
