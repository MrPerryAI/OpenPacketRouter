// show ip route lists RIP-learned routes, show ip rip lists the RIP table; both with | json.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createSession} from "../src/index.js";
import {engineBackend} from "../src/backends/engine.js";
import {ROOT} from "./helpers.js";

const spec = () => JSON.parse(fs.readFileSync(path.join(ROOT, "examples/rip-chain/spec.json"), "utf8"));

test("R1 shows the RIP routes it learned, with metric", () => {
  const s = createSession(engineBackend(spec()), "R1", {mode: "priv"});
  const r = s.exec("show ip route | json").json.find(x => x.prefix === "10.3.0.0/24");
  assert.deepEqual([r.protocol, r.nextHop, r.interface, r.metric], ["rip", "10.0.12.2", "eth1", 3]);
  assert.match(s.exec("show ip route").output, /^R  10\.3\.0\.0\/24 via 10\.0\.12\.2, out eth1 \[metric 3\]$/m);
  assert.match(s.exec("show ip route").output, /R = learned by RIP/);
});

test("show ip rip: connected (C) and learned (R) entries", () => {
  const s = createSession(engineBackend(spec()), "R2", {mode: "priv"});
  const rows = s.exec("show ip rip | json").json;
  assert.ok(rows.some(x => x.type === "C" && x.network === "10.0.12.0/30"));
  assert.ok(rows.some(x => x.type === "R" && x.network === "10.3.0.0/24" && x.metric === 2));
  assert.match(s.exec("show ip rip").output, /^Code\s+Network/);
});

test("a router without RIP says so", () => {
  const sp = {format: "openpacketrouter.spec/1", name: "x", nodes: [{name: "R", kind: "router", ifaces: {eth0: "10.0.0.1/24"}}, {name: "H", kind: "host", ifaces: {eth0: "10.0.0.2/24"}}], links: [["R:eth0", "H:eth0"]]};
  const s = createSession(engineBackend(sp), "R", {mode: "priv"});
  assert.match(s.exec("show ip rip").output, /not running/);
  assert.deepEqual(s.exec("show ip rip | json").json, []);
});
