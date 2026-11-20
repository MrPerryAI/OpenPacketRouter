// ping, traceroute (with pipes) and show interfaces.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createSession} from "../src/index.js";
import {engineBackend} from "../src/backends/engine.js";
import {runActions} from "../../engine/src/spec.js";
import {ROOT} from "./helpers.js";

const spec = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const sess = (p, dev) => createSession(engineBackend(spec(p)), dev);

// The same actions through the engine directly: the CLI must report exactly what the engine returned.
for (const [file, dev0, dst0] of [["validate/l3/fti-routed.json", null, null], ["validate/intervlan/roas.json", "A", "10.0.20.12"], ["validate/intervlan/roas.json", "A", "10.0.30.23"], ["validate/intervlan/svi.json", "SW1", "10.9.0.10"]]) {
  test(`ping and traceroute match the engine: ${file} ${dev0 ?? ""} ${dst0 ?? ""}`, () => {
    let dev = dev0, dst = dst0;
    const s0 = spec(file);
    if (!dev) { // first host, towards the first interface address of a router
      const host = s0.nodes.find(n => n.kind === "host"), r = s0.nodes.find(n => n.kind === "router");
      dev = host.name; dst = Object.values(r.ifaces)[0].split("/")[0];
    }
    const s = sess(file, dev);
    for (const cmd of ["ping", "traceroute"]) {
      const [want] = runActions(s0, [{do: cmd, src: dev, dst}]).map(r => r.result);
      assert.deepEqual(s.exec(`${cmd} ${dst} | json`).json, want);
      assert.equal(s.exec(`${cmd} ${dst} | json`).changed, "actions");
    }
  });
}

test("ping text, | include, and a switch with no IP interfaces", () => {
  const s = sess("examples/intervlan-roas/spec.json", "A");
  assert.match(s.exec("ping 10.0.20.12").output, /^Reply from 10\.0\.20\.12/);
  assert.equal(s.exec("traceroute 10.0.20.12 | include 10.0.10.1").output.trim(), "1  10.0.10.1");
  const sw = sess("examples/vlans/spec.json", "SW1");
  assert.match(sw.exec("ping 10.0.0.1").output, /^% SW1 is a switch with no IP interfaces/);
});

test("show interfaces: SVI, subinterface, trunk, access port, shaper", () => {
  const l3 = sess("examples/l3-switch/spec.json", "SW1"); l3.exec("enable");
  assert.deepEqual([l3.exec("show interfaces vlan10 | json").json].map(j => [j.vlan, j.addresses, j.link]), [[10, ["10.0.10.1/24"], "up"]]);
  assert.deepEqual(l3.exec("show interfaces tr0 | json").json.trunkVlans, [10, 20]);
  assert.equal(l3.exec("show interfaces p1 | json").json.accessVlan, 10);
  const r = sess("examples/intervlan-roas/spec.json", "R"); r.exec("enable");
  const j = r.exec("show interfaces eth0.20 | json").json;
  assert.deepEqual([j.parent, j.vlan], ["eth0", 20]);
  assert.match(r.exec("show interfaces eth0.20").output, /802\.1Q subinterface of eth0, VLAN 20/);
  const b = sess("examples/bottleneck/spec.json", "PC"); b.exec("enable");
  assert.equal(b.exec("show interfaces eth0 | json").json.shaper.rate, "1mbit");
  assert.equal(r.exec("show interfaces | json").json.length, 3);
});
