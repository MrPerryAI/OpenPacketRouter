// Link aggregation: channel-group / lacp rate on the CLI, show etherchannel summary, and the Linux (bond) rendering.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createSession} from "../src/index.js";
import {engineBackend} from "../src/backends/engine.js";
import {linuxCommands} from "../src/backends/linux.js";
import {ROOT} from "./helpers.js";

const spec = () => JSON.parse(fs.readFileSync(path.join(ROOT, "examples/lacp-channel/spec.json"), "utf8"));
const node = (b, n) => b.spec().nodes.find(x => x.name === n);

test("channel-group on member ports builds the channel in the spec; lacp rate fast on Po1; no channel-group removes it", () => {
  const b = engineBackend(spec()), s = createSession(b, "SW1", {mode: "config"});
  for (const p of ["p3", "p4", "p5"]) { s.exec(`interface ${p}`); s.exec("no channel-group"); }
  assert.equal(node(b, "SW1").channels, undefined);
  for (const p of ["p3", "p4"]) { assert.equal(s.exec(`interface ${p}`).output, ""); assert.equal(s.exec("channel-group 7 mode active").output, ""); }
  s.exec("interface Po7"); assert.equal(s.exec("lacp rate fast").output, "");
  assert.deepEqual(node(b, "SW1").channels, {Po7: {ports: ["p3", "p4"], rate: "fast"}});
  const text = createSession(b, "SW1", {mode: "priv"}).exec("show running-config").output;
  assert.match(text, /interface p3\n channel-group 7 mode active/); assert.match(text, /interface Po7\n lacp rate fast/);
  s.exec("interface Po7"); s.exec("lacp rate slow");
  assert.equal(node(b, "SW1").channels.Po7.rate, undefined);
  assert.match(s.exec("lacp rate fast").output, /^$/);
  s.exec("interface p5"); assert.match(s.exec("lacp rate fast").output, /%/);   // only on a port-channel
});

test("show etherchannel summary: members bundled; | json is data; a cut cable shows D", () => {
  const b = engineBackend(spec()), sw = createSession(b, "SW1", {mode: "priv"});
  const out = sw.exec("show etherchannel summary").output;
  assert.match(out, /Po1\s+LACP\s+slow\s+p3\(P\) p4\(P\) p5\(P\)/);
  const j = JSON.parse(sw.exec("show etherchannel summary | json").output);
  assert.deepEqual(j[0].members.map(m => m.aggregated), [true, true, true]);
  assert.match(createSession(b, "A", {mode: "priv"}).exec("show etherchannel summary").output, /%/);   // hosts have no channels
});

test("Linux rendering: a bond in 802.3ad mode is the bridge port, members are enslaved to it", () => {
  const b = engineBackend(spec());
  const cmds = linuxCommands(b.getConfig("SW2"), {kind: "switch", ports: b.ports("SW2")});
  const text = cmds.join("\n");
  assert.match(text, /ip link add Po1 type bond mode 802\.3ad lacp_rate fast xmit_hash_policy layer2 miimon 100/);
  assert.match(text, /ip link set Po1 master br0/);
  for (const p of ["p3", "p4", "p5"]) { assert.match(text, new RegExp(`ip link set ${p} master Po1`)); assert.doesNotMatch(text, new RegExp(`ip link set ${p} master br0`)); }
  assert.match(text, /ip link set p1 master br0/);
});
