// show running-config, replayed on a blank device, rebuilds the same device: for every device of every spec here.
import test from "node:test";
import assert from "node:assert/strict";
import {createSession} from "../src/index.js";
import {engineBackend} from "../src/backends/engine.js";
import {allSpecs, blankDevice} from "./helpers.js";

const specs = allSpecs();

test("there are specs to round-trip", () => assert.ok(specs.length >= 15, `found ${specs.length}`));

for (const {file, spec} of specs) {
  test(`round trip: ${file}`, () => {
    for (const node of spec.nodes) {
      const s = createSession(engineBackend(spec), node.name, {mode: "priv"});
      const text = s.exec("show running-config").output;
      assert.ok(text.startsWith(`hostname ${node.name}`), text);

      const b = engineBackend(blankDevice(spec, node.name));
      const r = createSession(b, "NEW", {mode: "config"});
      for (const line of text.split("\n")) {
        if (/^\s*(!|end$)/.test(line)) continue;
        const out = r.exec(line.trim());
        assert.ok(!out.output.startsWith("%") && !out.output.includes("\n%"), `${file} ${node.name}: "${line.trim()}" -> ${out.output}`);
        if (!line.startsWith(" ") && r.mode === "config-if" && !line.startsWith("interface")) assert.fail(`${line} left the session in config-if`);
      }
      const rebuilt = b.spec();
      assert.deepEqual(rebuilt.nodes.find(n => n.name === node.name), node, `${file} ${node.name}: node differs\n${text}`);
      assert.deepEqual(rebuilt.links, spec.links, `${file} ${node.name}: cables differ\n${text}`);
      // and printing it again gives the same text
      assert.equal(createSession(b, node.name, {mode: "priv"}).exec("show running-config").output, text);
    }
  });
}
