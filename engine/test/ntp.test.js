import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {validateSpec, runActions} from "../src/index.js";

const spec = () => JSON.parse(fs.readFileSync(new URL("../../validate/services/ntp-lan.json", import.meta.url)));
const acts = () => JSON.parse(fs.readFileSync(new URL("../../validate/services/ntp-lan.actions.json", import.meta.url)));

test("the NTP lab passes the spec check; a bad stratum is caught", () => {
  const v = validateSpec(spec(), acts()); assert.ok(v.ok, JSON.stringify(v.errors));
  for (const bad of [0, 16, "2"]) { const s = spec(); s.nodes[3].services.ntp = {stratum: bad}; assert.ok(validateSpec(s).errors.some(e => e.path === "$.nodes[3].services.ntp"), String(bad)); }
});

test("a client reads the server's stratum; offset is 0 (one clock); a host with no service answers port unreachable", () => {
  const r = runActions(spec(), acts()).map(x => x.result);
  for (const i of [0, 1]) assert.deepEqual([r[i].ok, r[i].stratum, r[i].leap, r[i].offset_ms], [true, 2, 0, 0]);
  assert.deepEqual([r[2].ok, r[2].error], [false, "port unreachable"]);
});
