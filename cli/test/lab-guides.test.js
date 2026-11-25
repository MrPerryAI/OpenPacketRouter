// docs/labs/*.md: every console line in a guide ("DEVICE> command") must be accepted by the CLI on that lab's spec.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createSession} from "../src/index.js";
import {engineBackend} from "../src/backends/engine.js";
import {ROOT} from "./helpers.js";

const dir = path.join(ROOT, "docs/labs");
const guides = fs.readdirSync(dir).filter(f => f.endsWith(".md") && f !== "README.md");

test("there is a guide for every example lab, and the index lists them", () => {
  const labs = fs.readdirSync(path.join(ROOT, "examples"), {withFileTypes: true}).filter(e => e.isDirectory()).map(e => e.name).sort();
  assert.deepEqual(guides.map(f => f.replace(/\.md$/, "")).sort(), labs);
  const index = fs.readFileSync(path.join(dir, "README.md"), "utf8");
  for (const l of labs) assert.ok(index.includes(`(${l}.md)`), `index lists ${l}`);
});

for (const f of guides) test(`guide ${f}: console commands work and relative links exist`, () => {
  const lab = f.replace(/\.md$/, ""), text = fs.readFileSync(path.join(dir, f), "utf8");
  const backend = engineBackend(JSON.parse(fs.readFileSync(path.join(ROOT, "examples", lab, "spec.json"), "utf8")));
  const sessions = {};
  let n = 0;
  for (const m of text.matchAll(/^([A-Za-z][\w-]*)> (.+)$/gm)) {
    const s = sessions[m[1]] ||= createSession(backend, m[1]);
    const out = s.exec(m[2]).output;
    assert.ok(!/^\s*\^?\s*$/.test(out) || m[2] === "enable", `${f}: ${m[1]}> ${m[2]} printed nothing`);
    assert.ok(!/% (Unknown|Invalid|Command is incomplete|Only)/.test(out), `${f}: ${m[1]}> ${m[2]} was refused: ${out}`);
    n++;
  }
  assert.ok(n > 0, "has console commands");
  for (const l of text.matchAll(/\]\((\.\.?\/[^)#]+)\)/g)) assert.ok(fs.existsSync(path.join(dir, l[1])), `${f}: link ${l[1]} exists`);
});
