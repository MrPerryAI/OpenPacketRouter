#!/usr/bin/env node
// openpacketrouter — run network specs from the command line.
//
//   openpacketrouter run spec.json [actions.json] [--trace] [--compact] [--text]
//   openpacketrouter check spec.json [actions.json]
//   openpacketrouter actions
//   openpacketrouter schema        (JSON Schema of the spec format, for editors and other tools)
//
// `run` prints one JSON document (format "openpacketrouter.result/1"): the spec name, and per action its
// result, the frames sent on every cable direction, and (with --trace) every decision the engine made,
// in plain English. --text prints a readable report instead of JSON. Without an actions file, the actions come from the spec's sibling
// <spec>.actions.json if it exists. `check` validates without running. Exit codes: 0 ok, 1 invalid
// spec/actions, 2 usage or file error.
import fs from "node:fs";
import {textReport} from "../src/report.js";
import {validateSpec, validateActions, runActions, ACTIONS, RESULT_FORMAT, SPEC_VERSION, SpecError} from "../src/spec.js";

const USAGE = `usage:
  openpacketrouter run spec.json [actions.json] [--trace] [--compact] [--text]
  openpacketrouter check spec.json [actions.json]
  openpacketrouter actions
  openpacketrouter schema`;

const die = (msg, code = 2) => { process.stderr.write(msg.endsWith("\n") ? msg : msg + "\n"); process.exit(code); };
const readJson = (file, what) => {
  let text; try { text = fs.readFileSync(file, "utf8"); } catch (e) { die(`cannot read ${what} ${file}: ${e.code || e.message}`); }
  try { return JSON.parse(text); } catch (e) { die(`${what} ${file} is not valid JSON: ${e.message}`, 1); }
};
const report = (what, v) => {
  for (const w of v.warnings) process.stderr.write(`warning: ${what} ${w.path}: ${w.message}\n`);
  for (const e of v.errors) process.stderr.write(`error: ${what} ${e.path}: ${e.message}\n`);
};

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith("--")));
const [cmd, specFile, actionsArg] = args.filter(a => !a.startsWith("--"));
for (const f of flags) if (!["--trace", "--compact", "--text", "--help"].includes(f)) die(`unknown option ${f}\n${USAGE}`);
if (flags.has("--help") || !cmd) die(USAGE, flags.has("--help") ? 0 : 2);

if (cmd === "schema") {
  process.stdout.write(fs.readFileSync(new URL("../spec.schema.json", import.meta.url), "utf8"));
  process.exit(0);
}
if (cmd === "actions") {
  for (const [name, def] of Object.entries(ACTIONS)) process.stdout.write(`${name}: ${def.required.join(", ")}\n`);
  process.exit(0);
}
if (!["run", "check"].includes(cmd)) die(`unknown command ${cmd}\n${USAGE}`);
if (!specFile) die(USAGE);

const spec = readJson(specFile, "spec");
const sibling = specFile.replace(/\.json$/, ".actions.json");
const actionsFile = actionsArg ?? (sibling !== specFile && fs.existsSync(sibling) ? sibling : null);
const actions = actionsFile ? readJson(actionsFile, "actions") : [];

const vs = validateSpec(spec); report("spec", vs);
const va = validateActions(actions, spec); report("actions", va);
if (!vs.ok || !va.ok) process.exit(1);

if (cmd === "check") {
  const n = spec.nodes.length, l = spec.links.length;
  process.stdout.write(`ok: ${spec.name ?? specFile} (spec version ${spec.version ?? SPEC_VERSION}): ${n} nodes, ${l} links, ${actions.length} actions\n`);
  process.exit(0);
}

let results;
try { results = runActions(spec, actions, {trace: flags.has("--trace") || flags.has("--text")}); }
catch (e) { if (e instanceof SpecError) die(e.message, 1); throw e; }
if (flags.has("--text")) { process.stdout.write(textReport(spec.name ?? specFile, results) + "\n"); process.exit(0); }
const doc = {format: RESULT_FORMAT, spec: spec.name ?? null, specVersion: spec.version ?? SPEC_VERSION, actions: results};
process.stdout.write(JSON.stringify(doc, null, flags.has("--compact") ? 0 : 1) + "\n");
