// The terminal program, driven the way a script would.
import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync, spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {ROOT} from "./helpers.js";

const BIN = path.join(ROOT, "cli/bin/opr-cli.mjs"), SPEC = path.join(ROOT, "examples/routed-lan-dns/spec.json");

test("-c commands with --json give one JSON array", () => {
  const out = JSON.parse(execFileSync("node", [BIN, SPEC, "R1", "--json", "-c", "enable", "-c", "show ip route | json"], {encoding: "utf8"}));
  assert.equal(out.length, 2);
  assert.ok(Array.isArray(out[1].json) && out[1].json.some(r => r.prefix === "10.0.0.0/24"));
});

test("stdin script, write saves the spec, a refused command exits 1", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opr-cli-")), f = path.join(dir, "spec.json");
  fs.copyFileSync(SPEC, f);
  const r = spawnSync("node", [BIN, f, "R1"], {input: "enable\nconf t\nhostname CORE\nend\nwrite\n", encoding: "utf8"});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(JSON.parse(fs.readFileSync(f, "utf8")).nodes.some(n => n.name === "CORE"));
  const bad = spawnSync("node", [BIN, f, "CORE", "-c", "enable", "-c", "conf t", "-c", "ip route 10.9.0.0/16 192.168.1.1"], {encoding: "utf8"});
  assert.equal(bad.status, 1);
  fs.rmSync(dir, {recursive: true});
});

test("--render linux prints the commands for the device; bad usage exits 2", () => {
  assert.match(execFileSync("node", [BIN, SPEC, "R1", "--render", "linux"], {encoding: "utf8"}), /ip addr add 10\.0\.0\.1\/24 dev eth0/);
  assert.equal(spawnSync("node", [BIN, SPEC], {encoding: "utf8"}).status, 2);
  assert.equal(spawnSync("node", [BIN, SPEC, "NOPE"], {encoding: "utf8"}).status, 2);
});

test("a YAML spec works: opr-cli reads it and write saves YAML back", async () => {
  const {dumpYaml, parseYaml} = await import("../../engine/src/yaml.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opr-cli-")), f = path.join(dir, "spec.yaml");
  fs.writeFileSync(f, dumpYaml(JSON.parse(fs.readFileSync(SPEC, "utf8"))));
  const r = spawnSync("node", [BIN, f, "R1"], {input: "enable\nshow ip route\nconf t\nhostname CORE\nend\nwrite\n", encoding: "utf8"});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /10\.0\.0\.0\/24/);
  assert.ok(parseYaml(fs.readFileSync(f, "utf8")).nodes.some(n => n.name === "CORE"));
  fs.rmSync(dir, {recursive: true});
});
