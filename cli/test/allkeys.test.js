// Every node key of the spec format has a CLI command: the fixture uses each key at least once, and its running-config round-trips.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {createSession} from "../src/index.js";
import {engineBackend} from "../src/backends/engine.js";
import {blankDevice, allSpecs} from "./helpers.js";
import {nodeKeys} from "../../engine/src/spec.js";
import {Network} from "../../engine/src/network.js";

const spec = JSON.parse(fs.readFileSync(new URL("./fixtures/all-keys.json", import.meta.url), "utf8"));

test("the fixture is a valid spec", () => assert.doesNotThrow(() => Network.fromSpec(spec)));

for (const node of spec.nodes) test(`all keys round trip: ${node.name}`, () => {
  const text = createSession(engineBackend(spec), node.name, {mode: "priv"}).exec("show running-config").output;
  const b = engineBackend(blankDevice(spec, node.name));
  const r = createSession(b, "NEW", {mode: "config"});
  for (const line of text.split("\n")) {
    if (/^\s*(!|end$)/.test(line)) continue;
    const out = r.exec(line.trim());
    assert.ok(!out.output.startsWith("%") && !out.output.includes("\n%"), `${node.name}: "${line.trim()}" -> ${out.output}`);
  }
  assert.deepEqual(b.spec().nodes.find(n => n.name === node.name), node, `${node.name}: node differs\n${text}`);
});

test("the links of the fixture round trip too: delay, loss and shaping", () => {
  const dev = "R", text = createSession(engineBackend(spec), dev, {mode: "priv"}).exec("show running-config").output;
  assert.match(text, /interface e0\n[^!]*\n delay 5\n/);
  assert.match(text, / loss pattern 1 0 1 0/);
  const b = engineBackend(blankDevice(spec, dev)), r = createSession(b, "NEW", {mode: "config"});
  for (const line of text.split("\n")) if (!/^\s*(!|end$)/.test(line)) assert.ok(!r.exec(line.trim()).output.startsWith("%"), line);
  assert.deepEqual(b.spec().links[0], spec.links[0]);
});

test("show interfaces says the delay and loss pattern, and gives them with | json", () => {
  const s = createSession(engineBackend(spec), "R", {mode: "priv"});
  assert.match(s.exec("show interfaces e0").output, /Cable delay 5 ms/);
  const row = JSON.parse(s.exec("show interfaces e0 | json").output);
  const e0 = Array.isArray(row) ? row[0] : row;
  assert.equal(e0.delay, 5); assert.deepEqual(e0.loss, {toBad: 1, toGood: 0, inBad: 1, inGood: 0});
});

// The guard: a new spec key must come with a CLI command, or this fails. Add the key to test/fixtures/all-keys.json
// (so the round-trip test above has to print it and read it back), or list it here with the reason it has no command.
const NO_COMMAND = {};
test("every node key of the spec format is used by the fixture, so it has a CLI command", () => {
  for (const kind of ["switch", "router", "host", "server"]) {
    const used = new Set(spec.nodes.filter(n => n.kind === kind).flatMap(n => Object.keys(n)));
    for (const k of nodeKeys(kind)) assert.ok(used.has(k) || NO_COMMAND[`${kind}.${k}`], `${kind} key "${k}" has no CLI command: add it to the CLI and to cli/test/fixtures/all-keys.json`);
  }
});

test("every key of a stp/vlan/etc. block that the CLI keeps is covered by the other round-trip specs", () => {
  const seen = new Set();
  for (const {spec: s} of allSpecs()) for (const n of s.nodes) for (const k of Object.keys(n)) seen.add(`${n.kind}.${k}`);
  for (const kind of ["switch", "router"]) for (const k of nodeKeys(kind)) assert.ok(seen.has(`${kind}.${k}`) || NO_COMMAND[`${kind}.${k}`] || spec.nodes.some(n => n.kind === kind && k in n), `${kind}.${k} is in no spec`);
});
