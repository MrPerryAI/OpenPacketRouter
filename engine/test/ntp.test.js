import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {validateSpec} from "../src/spec.js";
import {runActions} from "../src/spec.js";

const spec = () => JSON.parse(fs.readFileSync(new URL("../../validate/services/ntp-lan.json", import.meta.url)));
const acts = () => JSON.parse(fs.readFileSync(new URL("../../validate/services/ntp-lan.actions.json", import.meta.url)));

test("the NTP lab passes the spec check; a bad stratum is caught", () => {
  assert.deepEqual(validateSpec(spec()).errors, []);
  const s = spec(); s.nodes[3].services.ntp = 16;
  assert.ok(validateSpec(s).errors.some(e => e.path === "$.nodes[3].services.ntp"));
});

test("a client gets the server's stratum; a host with no NTP service gives port unreachable", () => {
  const r = runActions(spec(), acts()).map(x => x.result);
  assert.deepEqual(r[0], {ok: true, from: "10.0.0.10", stratum: 2, version: 4, received: ["vn=4 mode=3 len=48"]});
  assert.equal(r[2].stratum, 2);
  const bad = runActions(spec(), [{do: "ntp", src: "A", dst: "10.0.0.20"}])[0].result;
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.received, []);
});
