// show ipv6 route / neighbors / ripng, with | json, on the RIPng chain.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createSession} from "../src/index.js";
import {engineBackend} from "../src/backends/engine.js";
import {ROOT} from "./helpers.js";

const spec = () => JSON.parse(fs.readFileSync(path.join(ROOT, "validate/ripng/ripng-chain.json"), "utf8"));
const sess = dev => createSession(engineBackend(spec()), dev, {mode: "priv"});

test("show ipv6 route: connected, and the prefix learned by RIPng with its metric", () => {
  const s = sess("R1");
  const r = s.exec("show ipv6 route | json").json.find(x => x.prefix === "2001:db8:3::/64");
  assert.equal(r.protocol, "ripng"); assert.equal(r.interface, "eth1"); assert.equal(r.metric, 3);
  assert.ok(s.exec("show ipv6 route | json").json.some(x => x.protocol === "connected" && x.interface === "eth0"));
  assert.match(s.exec("show ipv6 route").output, /^R  2001:db8:3::\/64 via .*, out eth1 \[metric 3\]$/m);
});

test("show ipv6 ripng: C and R entries; a router without RIPng says so", () => {
  const rows = sess("R2").exec("show ipv6 ripng | json").json;
  assert.ok(rows.some(x => x.type === "C" && x.network === "2001:db8:12::/64"));
  assert.ok(rows.some(x => x.type === "R" && x.network === "2001:db8:3::/64" && x.metric === 2));
  assert.match(sess("R2").exec("show ipv6 ripng").output, /^Code\s+Network/);
  assert.match(sess("H1").exec("show ipv6 route").output, /Legend/);
  assert.match(sess("H1").exec("show ipv6 ripng").output, /% (Unknown|Invalid)|not running/);
});

test("show ipv6 neighbors: empty at first, with a hint; JSON is an array", () => {
  const s = sess("H1");
  assert.match(s.exec("show ipv6 neighbors").output, /empty/);
  assert.deepEqual(s.exec("show ipv6 neighbors | json").json, []);
});

test("an IPv4-only device says IPv6 is not configured", () => {
  const sp = {format: "openpacketrouter.spec/1", name: "x", nodes: [{name: "R", kind: "router", ifaces: {eth0: "10.0.0.1/24"}}, {name: "H", kind: "host", ifaces: {eth0: "10.0.0.2/24"}}], links: [["R:eth0", "H:eth0"]]};
  const s = createSession(engineBackend(sp), "R", {mode: "priv"});
  assert.match(s.exec("show ipv6 route").output, /not configured/);
});
