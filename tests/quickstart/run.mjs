// Release check: runs every command in README.md's "Quick start" code blocks (taken from the README itself, so the
// text can't drift) and checks `npm pack` contents for the engine and the CLI. Run from anywhere: node tests/quickstart/run.mjs
import {readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let failed = 0;
const fail = (m) => { failed++; console.log("FAIL " + m); };
const ok = (m) => console.log("ok   " + m);

// 1. Quick start commands.
const readme = readFileSync(path.join(root, "README.md"), "utf8");
const qs = readme.split(/^## /m).find((s) => s.startsWith("Quick start"));
if (!qs) { console.log("FAIL no Quick start section"); process.exit(1); }
const blocks = [...qs.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
const cmds = [];
for (const b of blocks) {
  const joined = b.replace(/\\\n/g, " ");
  for (let line of joined.split("\n")) {
    line = line.replace(/\s+#.*$/, "").trim();   // trailing comment
    if (line) cmds.push(line);
  }
}
let ran = 0;
for (const c of cmds) {
  if (/^git clone\b/.test(c) || /^cd OpenPacketRouter$/.test(c)) continue;   // we already have the checkout
  if (/http\.server/.test(c)) {                                              // long-running: check the page exists
    const m = c.match(/http\.server (\d+)/);
    const f = path.join(root, "studio/index.html");
    try { readFileSync(f); ok("studio page exists for: " + c); } catch { fail("studio/index.html missing for: " + c); }
    if (!m) fail("cannot read port in: " + c);
    continue;
  }
  const r = spawnSync("bash", ["-c", c], {cwd: root, encoding: "utf8", timeout: 120000, input: "exit\n"});
  ran++;
  if (r.status !== 0) fail(`exit ${r.status}: ${c}\n${(r.stderr || "").slice(0, 400)}`);
  else if (!r.stdout.trim() && !/^\S.*\bR1$/.test(c)) fail("no output: " + c);
  else ok(c.slice(0, 90));
}
if (ran < 3) fail("expected at least 3 runnable quick start commands, found " + ran);

// What the README says the commands print.
const text = spawnSync("node", ["engine/bin/openpacketrouter.mjs", "run", "examples/loop-with-stp/spec.json", "examples/loop-with-stp/actions.json", "--text"], {cwd: root, encoding: "utf8"}).stdout;
if (!/\S/.test(text) || !/frame/i.test(text)) fail("--text output does not describe frames");
else ok("--text prints a frame-by-frame account");
const json = spawnSync("node", ["engine/bin/openpacketrouter.mjs", "run", "examples/loop-with-stp/spec.json", "examples/loop-with-stp/actions.json"], {cwd: root, encoding: "utf8"}).stdout;
try { JSON.parse(json); ok("without --text the output is JSON"); } catch { fail("without --text the output is not JSON"); }
const cli = spawnSync("node", ["cli/bin/opr-cli.mjs", "examples/routed-lan-dns/spec.json", "R1", "-c", "show ip route | json"], {cwd: root, encoding: "utf8"}).stdout;
try { JSON.parse(cli.slice(cli.search(/^[[{]/m))); ok("'| json' gives JSON"); } catch { fail("'show ip route | json' is not JSON"); }

// Links in the quick start point at files that exist.
for (const m of qs.matchAll(/\]\(((?!https?:)[^)#]+)/g)) {
  try { readFileSync(path.join(root, m[1].replace(/\/$/, "")), "utf8"); ok("link " + m[1]); }
  catch (e) { if (e.code === "EISDIR") ok("link " + m[1]); else fail("broken link " + m[1]); }
}

// 2. npm pack contents (dry run, no publish).
for (const [pkg, must] of [["engine", ["bin/openpacketrouter.mjs", "spec.schema.json", "src/index.js", "package.json"]], ["cli", ["bin/opr-cli.mjs", "src/index.js", "commands/index.js", "commands/base.json", "package.json"]]]) {
  const r = spawnSync("npm", ["pack", "--dry-run", "--json"], {cwd: path.join(root, pkg), encoding: "utf8"});
  if (r.status !== 0) { fail(`npm pack ${pkg}: ${r.stderr.slice(0, 300)}`); continue; }
  const files = JSON.parse(r.stdout)[0].files.map((f) => f.path);
  for (const m of must) files.includes(m) ? ok(`${pkg} tarball has ${m}`) : fail(`${pkg} tarball lacks ${m}`);
  const bad = files.filter((f) => /^(test|tests|validate|node_modules|tools)\//.test(f));
  bad.length ? fail(`${pkg} tarball leaks ${bad.slice(0, 5).join(", ")}`) : ok(`${pkg} tarball has no tests/validate/tools/node_modules`);
}

// 3. Install both tarballs into an empty directory (as a user would) and run the commands from there.
{
  const tmp = mkdtempSync(path.join(tmpdir(), "opr-install-"));
  const tars = [];
  for (const pkg of ["engine", "cli"]) {
    const r = spawnSync("npm", ["pack", "--json", "--pack-destination", tmp], {cwd: path.join(root, pkg), encoding: "utf8"});
    if (r.status !== 0) { fail(`npm pack ${pkg}: ${r.stderr.slice(0, 300)}`); continue; }
    tars.push(path.join(tmp, JSON.parse(r.stdout)[0].filename));
  }
  const inst = path.join(tmp, "app");
  mkdirSync(inst);
  writeFileSync(path.join(inst, "package.json"), "{\"name\":\"installcheck\",\"private\":true}");
  const r = spawnSync("npm", ["install", "--no-audit", "--no-fund", ...tars], {cwd: inst, encoding: "utf8"});
  if (r.status !== 0) fail("npm install of both tarballs: " + (r.stderr || "").slice(0, 400));
  else {
    const spec = path.join(root, "examples/routed-lan-dns/spec.json");
    const c = spawnSync("npx", ["--no-install", "opr-cli", spec, "R1", "-c", "show ip route | json"], {cwd: inst, encoding: "utf8"});
    try { JSON.parse(c.stdout.slice(c.stdout.search(/^[[{]/m))); ok("installed opr-cli prints JSON"); } catch { fail("installed opr-cli: " + (c.stderr || c.stdout).slice(0, 400)); }
    const e = spawnSync("npx", ["--no-install", "openpacketrouter", "run", path.join(root, "examples/loop-with-stp/spec.json"), path.join(root, "examples/loop-with-stp/actions.json"), "--text"], {cwd: inst, encoding: "utf8"});
    /frame/i.test(e.stdout) ? ok("installed openpacketrouter runs a lab") : fail("installed openpacketrouter: " + (e.stderr || e.stdout).slice(0, 400));
  }
  rmSync(tmp, {recursive: true, force: true});
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall quick start and pack checks passed");
process.exit(failed ? 1 : 0);
