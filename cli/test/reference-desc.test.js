import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

// The "What it does" column must describe the command, not the help of its last argument.
const ref = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../docs/cli-reference.md"), "utf8");
const row = syntax => {
  const line = ref.split("\n").find(l => l.startsWith("| `" + syntax + "` |"));
  assert.ok(line, `no row for ${syntax}`);
  return line.split(" | ").pop();
};

test("a command with a shorter base reads as the base plus what the extra keywords add", () => {
  const d = row("redistribute connected metric N");
  assert.match(d, /^Announce routes from outside OSPF/);
  assert.match(d, /With `metric`:/);
  assert.doesNotMatch(d, /^Number/);
});

test("a command with no base starts from its first keyword", () => {
  assert.match(row("shape rate RATE burst BYTES limit QUEUE"), /^Limit how fast this interface sends/);
  assert.match(row("storm-control broadcast rate RATE burst BYTES"), /^Limit the traffic/);
});

test("no-forms and one-word commands", () => {
  assert.match(row("no vlan VLAN"), /^Delete a VLAN/);
  assert.match(row("hostname NAME"), /^Rename this device/);
});
