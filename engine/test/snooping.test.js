import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {runActions, validateSpec} from "../src/index.js";

const spec = JSON.parse(fs.readFileSync(new URL("../../validate/dhcp-snooping/snoop.json", import.meta.url)));
const off = JSON.parse(JSON.stringify(spec)); delete off.nodes[0].dhcpSnooping;

test("the rogue server's offers are dropped on the untrusted port and counted", () => {
  assert.ok(validateSpec(spec).ok);
  const [r, s] = runActions(spec, [{do: "dhcp", src: "PC1"}, {do: "dhcpSnooping", switch: "SW"}]);
  assert.deepEqual(r.result, {ok: true, ip: "10.0.0.100", server: "10.0.0.1", lease: 3600});
  assert.equal(r.frames["ROGUE:eth0>SW:p3"], 1);      // the rogue answered ...
  assert.equal(r.frames["SW:p2>PC1:eth0"], 2);        // ... but only the trusted server's OFFER and ACK reached the client
  assert.deepEqual(s.result, {switch: "SW", trusted: ["p1"], dropped: {p3: 1}});
});

test("without snooping the rogue's offer can win (and nothing is counted)", () => {
  const [s] = runActions(off, [{do: "dhcpSnooping", switch: "SW"}]);
  assert.deepEqual(s.result, {switch: "SW", trusted: [], dropped: {}});
});

test("a rogue server on the only server port: trusting that port lets it through", () => {
  const t = JSON.parse(JSON.stringify(spec)); t.nodes[0].dhcpSnooping.trusted = ["p3"];
  const [r] = runActions(t, [{do: "dhcp", src: "PC1"}]);
  assert.equal(r.result.ok, true);
});

test("spec validation: trusting a port that has no cable is an error", () => {
  const bad = JSON.parse(JSON.stringify(spec)); bad.nodes[0].dhcpSnooping.trusted = ["p9"];
  assert.equal(validateSpec(bad).ok, false);
});
