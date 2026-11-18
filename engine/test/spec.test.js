import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {execFileSync, spawnSync} from "node:child_process";
import {validateSpec, validateActions, runActions, loadSpec, SpecError, RESULT_FORMAT} from "../src/index.js";

const file = name => new URL(`../../validate/l3/${name}`, import.meta.url);
const read = name => JSON.parse(fs.readFileSync(file(name)));
const CLI = new URL("../bin/openpacketrouter.mjs", import.meta.url).pathname;
const tiny = () => ({version: 1, name: "tiny", nodes: [
  {name: "SW", kind: "switch"},
  {name: "A", kind: "host", ifaces: {eth0: "10.0.0.1/24"}, gw: "10.0.0.254"},
  {name: "B", kind: "host", ifaces: {eth0: "10.0.0.2/24"}}],
  links: [["A:eth0", "SW:p1"], ["B:eth0", "SW:p2", 2]]});

test("every validation spec loads unchanged, without errors or warnings", () => {
  for (const s of ["fti-routed", "fti-loop", "fti-noreturn"]) {
    const v = validateSpec(read(`${s}.json`));
    assert.deepEqual([v.errors, v.warnings], [[], []], s);
    assert.ok(validateActions(read(`${s}.actions.json`), read(`${s}.json`)).ok, s);
  }
});

test("bad specs: every problem is reported with a path", () => {
  const s = tiny();
  s.version = 2;
  s.nodes[1].ifaces.eth0 = "10.0.0.300/24";
  s.nodes[2].gw = "192.168.1.1";
  s.nodes.push({name: "A", kind: "host"}, {name: "X", kind: "firewall"});
  s.links.push(["B:eth9", "SW:p3"], ["Q:eth0", "SW:p4"], ["A:eth0", "SW:p5"]);
  const v = validateSpec(s);
  assert.equal(v.ok, false);
  const paths = v.errors.map(e => e.path);
  for (const p of ["$.version", "$.nodes[1].ifaces.eth0", "$.nodes[2].gw", "$.nodes[3].name", "$.nodes[4].kind", "$.links[2]", "$.links[3]", "$.links[4]"])
    assert.ok(paths.includes(p), `missing ${p} in ${JSON.stringify(v.errors)}`);
  assert.match(v.errors.find(e => e.path === "$.links[2]").message, /B has no interface "eth9"/);
  assert.match(v.errors.find(e => e.path === "$.links[4]").message, /cabled twice/);
});

test("unknown keys are warnings, so specs from newer features still load", () => {
  const s = tiny(); s.nodes[0].futureFeature = {x: 1};
  const v = validateSpec(s);
  assert.equal(v.ok, true);
  assert.equal(v.warnings[0].path, "$.nodes[0].futureFeature");
});

test("loadSpec throws a SpecError listing everything wrong", () => {
  const s = tiny(); s.nodes[1].gw = "nope";
  assert.throws(() => loadSpec(s), e => e instanceof SpecError && /\$\.nodes\[1\]\.gw/.test(e.message));
});

test("actions are checked against the spec", () => {
  const v = validateActions([{do: "ping", src: "Z", dst: "10.0.0.2"}, {do: "teleport"}, {do: "dns", src: "A"}], tiny());
  assert.deepEqual(v.errors.map(e => e.path), ["$[0].src", "$[1].do", "$[2].server", "$[2].name"]);
});

test("runActions: results, frames per cable, optional trace", () => {
  const [r] = runActions(tiny(), [{do: "ping", src: "A", dst: "10.0.0.2"}], {trace: true});
  assert.equal(r.result.ok, true);
  assert.deepEqual(r.frames, {"A:eth0>SW:p1": 2, "SW:p2>B:eth0": 2, "B:eth0>SW:p2": 2, "SW:p1>A:eth0": 2});
  assert.ok(r.trace.some(e => e.node === "SW" && e.event === "flood"));
});

test("CLI run prints a versioned result document; check and errors use exit codes", () => {
  const out = JSON.parse(execFileSync("node", [CLI, "run", file("fti-loop.json").pathname]));
  assert.equal(out.format, RESULT_FORMAT);
  assert.equal(out.actions.length, 2);                       // picked up fti-loop.actions.json
  assert.equal(out.actions[0].result.error, "time exceeded");
  assert.match(execFileSync("node", [CLI, "check", file("fti-routed.json").pathname]).toString(), /^ok: FTI routed/);

  const dir = fs.mkdtempSync(new URL("./.tmp-", import.meta.url).pathname);
  try {
    const bad = `${dir}/bad.json`; const s = tiny(); s.links[0][0] = "A:eth7"; fs.writeFileSync(bad, JSON.stringify(s));
    const r = spawnSync("node", [CLI, "check", bad], {encoding: "utf8"});
    assert.equal(r.status, 1);
    assert.match(r.stderr, /error: spec \$\.links\[0\]: A has no interface "eth7"/);
    assert.equal(spawnSync("node", [CLI, "frobnicate"]).status, 2);
  } finally { fs.rmSync(dir, {recursive: true}); }
});

test("--text report: result line, decisions in plain English, frames per cable", () => {
  const out = execFileSync("node", [CLI, "run", file("fti-routed.json").pathname, "--text"]).toString();
  assert.match(out, /^# FTI routed/);
  assert.match(out, /1\. ping ZFW-VOICE → 10\.1\.0\.1: ok from 10\.1\.0\.1 in 8 ms/);
  assert.match(out, /SW-ZFW +IPv4 10\.1\.0\.10 → 10\.1\.0\.1 ttl 64 echo request: 02:00:00:00:00:04 learned on p1/);
  assert.match(out, /frames: 9 on 5 cable directions/);
  assert.doesNotMatch(out, /VLAN 0 not allowed/);       // plain switches forward known unicast, they don't drop it
test("interface names that `ip link` would read as a keyword get a warning", () => {
  const s = tiny(); s.nodes.push({name: "R", kind: "router", ifaces: {a: "10.9.0.1/24", lan: "10.8.0.1/24"}}); s.links.push(["R:a", "SW:m"]);
  const v = validateSpec(s);
  assert.equal(v.ok, true);
  assert.deepEqual(v.warnings.map(w => w.path), ["$.nodes[3].ifaces.a", "$.links[2]"]);
  assert.match(v.warnings[0].message, /keyword "address"/);
  for (const name of ["fti-routed", "fti-loop", "fti-noreturn"]) assert.deepEqual(validateSpec(read(`${name}.json`)).warnings, []);
});

test("CLI check knows stp and vlans (no 'unknown key' warnings for the L2 specs)", () => {
  for (const f of ["l2/stp-ring.json", "l2/vlan-trunk.json"]) {
    const r = spawnSync("node", [CLI, "check", new URL(`../../validate/${f}`, import.meta.url).pathname], {encoding: "utf8"});
    assert.equal(r.status, 0); assert.equal(r.stderr, "", f);
  }
});
