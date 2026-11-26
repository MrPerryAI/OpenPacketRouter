import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {validateSpec, runActions} from "../src/index.js";
import {syslogText} from "../src/apps.js";

const spec = () => JSON.parse(fs.readFileSync(new URL("../../validate/services/syslog-lan.json", import.meta.url)));
const acts = () => JSON.parse(fs.readFileSync(new URL("../../validate/services/syslog-lan.actions.json", import.meta.url)));

test("syslog priority is facility * 8 + severity, and the text is RFC 3164 shaped", () => {
  assert.equal(syslogText("A", 0, {message: "hi"}), "<13>Jan  1 00:00:00 A user: hi");
  assert.equal(syslogText("B", 3661, {message: "x", tag: "t", facility: "local4", severity: "warning"}), "<164>Jan  1 01:01:01 B t: x");
});

test("the syslog lab passes the spec check; a bad syslog key is caught", () => {
  const v = validateSpec(spec(), acts()); assert.ok(v.ok, JSON.stringify(v.errors));
  const s = spec(); s.nodes[3].services.syslog = "yes";
  assert.ok(validateSpec(s).errors.some(e => e.path === "$.nodes[3].services.syslog"));
});

test("a message is stored by the log server only; one to a host with no service gets nothing stored", () => {
  const r = runActions(spec(), acts()).map(x => x.result);
  assert.deepEqual(r[0].received, ["<13>Jan  1 00:00:00 A user: link up on eth0"]);
  assert.match(r[1].received[0], /^<164>.* B monitor: disk 92% full$/);
  assert.deepEqual(r[3], {ok: true, received: []});
  assert.equal(runActions(spec(), [{do: "syslog", src: "A", dst: "10.0.0.10", message: "m", facility: "nope"}])[0].result.ok, false);
});
