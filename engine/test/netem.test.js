import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {runActions, validateSpec} from "../src/index.js";
import {LossModel} from "../src/link.js";

const read = f => JSON.parse(fs.readFileSync(new URL(`../../validate/netem/${f}`, import.meta.url)));

test("link delay: a round trip takes the delays on the way (ARP and echo, both ways)", () => {
  const [r1, r2] = runActions(read("delay.json"), read("delay.actions.json"));
  assert.equal(r1.result.rtt_ms, 60); assert.equal(r2.result.rtt_ms, 60);   // 2 x (5 + 10) ms for ARP, 2 x 15 ms for the echo
});

// the patterns Linux's netem gemodel gives with all-or-nothing probabilities (probed in CI: validate/netem)
const pattern = (m, n) => { const l = new LossModel(m); return Array.from({length: n}, () => l.lose() ? "x" : "."); };
test("loss model patterns match what netem produced on the runner", () => {
  assert.deepEqual(pattern({toBad: 1, toGood: 1, inBad: 1, inGood: 0}, 6).join(""), ".x.x.x");
  assert.deepEqual(pattern({toBad: 1, toGood: 1, inBad: 0, inGood: 1}, 6).join(""), "x.x.x.");
  assert.deepEqual(pattern({toBad: 1, toGood: 0, inBad: 1, inGood: 0}, 5).join(""), ".xxxx");
  assert.deepEqual(pattern({toBad: 1, toGood: 0, inBad: 0, inGood: 1}, 5).join(""), "x....");
  assert.deepEqual(pattern({toBad: 0, toGood: 0, inBad: 0, inGood: 1}, 4).join(""), "xxxx");
  assert.deepEqual(pattern({toBad: 0, toGood: 0, inBad: 1, inGood: 0}, 4).join(""), "....");
});

test("loss spec: counted drops and frames; fractions and shaper+loss on one end are rejected", () => {
  const spec = read("loss.json");
  assert.ok(validateSpec(spec).ok);
  const [r] = runActions(spec, [{do: "udpBurst", src: "A", dst: "10.0.0.2", port: 9999, count: 10, size: 100}]);
  assert.equal(r.drops["A:eth0"], 5);
  const frac = JSON.parse(JSON.stringify(spec)); frac.links[0][3].loss.inBad = 0.5;
  assert.equal(validateSpec(frac).ok, false);
  const both = JSON.parse(JSON.stringify(spec)); both.links[0][3].shape = {rate: "1mbit", burst: 2000, limit: 4000};
  assert.equal(validateSpec(both).ok, false);
});
