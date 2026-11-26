// The definition files themselves: they compile, every handler exists, every keyword is explained, no duplicates.
import test from "node:test";
import assert from "node:assert/strict";
import {compile, DEFINITIONS, HANDLERS, SHOWS} from "../src/index.js";

const table = compile(DEFINITIONS);
const SESSION = ["session.enable", "session.disable", "session.configure", "session.exit", "session.end", "session.write", "tools.ping", "tools.traceroute", "tools.ntp"];

test("every definition compiles and names a handler that exists", () => {
  assert.ok(table.commands.length > 60, `${table.commands.length} commands`);
  for (const c of table.commands) {
    const name = c.handler.includes(":") ? c.handler.slice(0, c.handler.indexOf(":")) : c.handler;
    assert.ok(HANDLERS[name] || SHOWS[name] || SESSION.includes(name), `${c.feature}: "${c.syntax}" -> missing handler ${c.handler}`);
  }
});

test("every keyword has a help line in its mode", () => {
  for (const c of table.commands) for (const t of c.tokens) if (t.lit)
    for (const m of c.modes) assert.ok(table.helpFor(m, t.lit), `${c.feature}: "${c.syntax}": no help for "${t.lit}" in ${m}`);
});

test("no two definitions share a syntax in the same mode and device kind", () => {
  const seen = new Map();
  for (const c of table.commands) for (const m of c.modes) for (const k of c.kinds || ["router", "switch", "host", "server"]) {
    const key = `${m}|${k}|${c.tokens.map(t => t.lit || `<${t.type.hint}>`).join(" ")}`;
    assert.ok(!seen.has(key), `duplicate: ${key} (${seen.get(key)} and ${c.feature})`);
    seen.set(key, c.feature);
  }
});

test("a bad definition is refused with a reason", () => {
  assert.throws(() => compile([{feature: "x", commands: [{modes: ["config"], syntax: "foo BAR", args: {BAR: "nope"}, handler: "h"}]}]), /unknown type "nope"/);
  assert.throws(() => compile([{feature: "x", commands: [{modes: ["config"], syntax: "Foo", handler: "h"}]}]), /neither a keyword/);
});
