import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {Network, ping, validateSpec} from "../src/index.js";

const chain = () => JSON.parse(fs.readFileSync(new URL("../../validate/ripng/ripng-chain.json", import.meta.url)));

test("the RIPng chain spec passes the spec check; bad ripng keys are caught", () => {
  const v = validateSpec(chain()); assert.ok(v.ok, JSON.stringify(v.errors));
  const s = chain(); s.nodes[1].ripng = {networks: ["eth9"], splitHorizon: "x", timers: {update: -1}};
  const paths = validateSpec(s).errors.map(e => e.path);
  for (const p of ["$.nodes[1].ripng.networks[0]", "$.nodes[1].ripng.splitHorizon", "$.nodes[1].ripng.timers.update"]) assert.ok(paths.includes(p), p);
});

test("RIPng converges over link-local next hops, answers pings, and poisons routes on carrier loss", () => {
  const net = Network.fromSpec(chain());
  net.run(14);
  const r1 = net.node("R1").ripng.describe(), far = r1.find(r => r.network === "2001:db8:3::/64");
  assert.equal(far.metric, 3); assert.ok(far.nextHop.startsWith("fe80::"), far.nextHop);
  assert.equal(r1.find(r => r.network === "2001:db8:1::/64").type, "C");
  assert.ok(ping(net, "H1", "2001:db8:3::10", {timeout: 2}).ok);
  net.setLink("R2:eth1", false); net.run(net.time + 4);
  assert.equal(net.node("R1").ripng.describe().find(r => r.network === "2001:db8:3::/64").metric, 16);
  assert.equal(ping(net, "H1", "2001:db8:3::10", {timeout: 2}).ok, false);
});
