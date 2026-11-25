import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {runActions, validateSpec} from "../src/spec.js";

const spec = JSON.parse(fs.readFileSync(new URL("../../validate/span/span-lab.json", import.meta.url)));
const acts = [{do: "ping", src: "A", dst: "10.0.0.2"}];

test("monitor sessions copy frames to the destination port only", () => {
  const [r] = runActions(spec, acts);
  assert.equal(r.result.ok, true);
  assert.equal(r.frames["SW:p4>M:eth0"], 6);   // session 1: what p1 receives and sends, what p2 receives
  assert.equal(r.frames["SW:p5>N:eth0"], 1);   // session 2: what p3 sends (the ARP flood)
  assert.equal(r.frames["M:eth0>SW:p4"], undefined);
});
test("a monitor port does not switch what it hears", () => {
  const [r] = runActions(spec, [{do: "ping", src: "M", dst: "10.0.0.1"}]);
  assert.equal(r.result.ok, false);
  assert.equal(r.frames["SW:p1>A:eth0"], undefined);
});
test("spec validation rejects a destination that is also a source, and unknown ports", () => {
  const bad = JSON.parse(JSON.stringify(spec)); bad.nodes[0].monitor["1"].sources.p4 = "rx";
  assert.ok(validateSpec(bad).errors.some(e => /destination and a monitor source/.test(e.message || e)));
  const bad2 = JSON.parse(JSON.stringify(spec)); bad2.nodes[0].monitor["1"].destination = "p9";
  assert.ok(validateSpec(bad2).errors.length > 0);
});
