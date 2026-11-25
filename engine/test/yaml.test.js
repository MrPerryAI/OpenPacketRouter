import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {parseYaml, parseData, dumpYaml, YamlError} from "../src/yaml.js";
import {validateSpec} from "../src/spec.js";

test("scalars, maps, lists, comments", () => {
  const y = `# top
name: lab one   # trailing
count: 3
ratio: -1.5
on: true
off: false
nothing: null
quoted: "a: b # not comment"
single: 'it''s'
mac: 02:00:00:00:00:01
ip: 10.0.0.1/24
list:
  - a
  - 2
  - {x: 1, y: [1, 2]}
same:
- p
- q
nested:
  k:
    - id: 1
      v: one
    - id: 2
      v: two
`;
  assert.deepEqual(parseYaml(y), {
    name: "lab one", count: 3, ratio: -1.5, on: true, off: false, nothing: null,
    quoted: "a: b # not comment", single: "it's", mac: "02:00:00:00:00:01", ip: "10.0.0.1/24",
    list: ["a", 2, {x: 1, y: [1, 2]}], same: ["p", "q"],
    nested: {k: [{id: 1, v: "one"}, {id: 2, v: "two"}]},
  });
});

test("errors name the line", () => {
  assert.throws(() => parseYaml("a: 1\n\tb: 2"), YamlError);
  assert.throws(() => parseYaml("a: 1\na: 2"), /duplicate key/);
  assert.throws(() => parseYaml("a: &x 1"), /unsupported/);
  assert.throws(() => parseYaml("a: [1, 2"), /line 1/);
  assert.throws(() => parseYaml("a: 1\n  b: 2"), /indentation/);
});

test("parseData picks the parser by extension", () => {
  assert.deepEqual(parseData('{"a":1}', "x.json"), {a: 1});
  assert.deepEqual(parseData("a: 1", "x.yml"), {a: 1});
});

test("every JSON example converts to YAML-equivalent and validates", () => {
  const dir = new URL("../../examples/", import.meta.url);
  let n = 0;
  for (const f of fs.readdirSync(dir, {recursive: true})) {
    if (!f.endsWith(".json") || f.endsWith(".actions.json")) continue;
    const spec = JSON.parse(fs.readFileSync(new URL(f, dir), "utf8"));
    if (!spec || !Array.isArray(spec.nodes ?? spec.devices ?? [])) continue;
    const back = parseYaml(dumpYaml(spec));
    assert.deepEqual(back, spec, f);
    assert.equal(validateSpec(back).ok, validateSpec(spec).ok, f);
    n++;
  }
  assert.ok(n > 0);
});

test("openpacketrouter run/check accept a YAML spec and a sibling YAML actions file", async () => {
  const {execFileSync, spawnSync} = await import("node:child_process");
  const os = await import("node:os"), path = await import("node:path");
  const bin = new URL("../bin/openpacketrouter.mjs", import.meta.url).pathname;
  const src = new URL("../../examples/routed-lan-dns/", import.meta.url);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opr-yaml-"));
  fs.writeFileSync(path.join(dir, "lab.yaml"), dumpYaml(JSON.parse(fs.readFileSync(new URL("spec.json", src), "utf8"))));
  fs.writeFileSync(path.join(dir, "lab.actions.yaml"), dumpYaml(JSON.parse(fs.readFileSync(new URL("actions.json", src), "utf8"))));
  const viaJson = JSON.parse(execFileSync("node", [bin, "run", new URL("spec.json", src).pathname, new URL("actions.json", src).pathname, "--compact"], {encoding: "utf8"}));
  const viaYaml = JSON.parse(execFileSync("node", [bin, "run", path.join(dir, "lab.yaml"), "--compact"], {encoding: "utf8"}));
  assert.deepEqual(viaYaml, viaJson);
  fs.writeFileSync(path.join(dir, "bad.yaml"), "nodes: [1,\n");
  const bad = spawnSync("node", [bin, "check", path.join(dir, "bad.yaml")], {encoding: "utf8"});
  assert.equal(bad.status, 1); assert.match(bad.stderr, /not valid YAML.*line 1/);
  fs.rmSync(dir, {recursive: true});
});
