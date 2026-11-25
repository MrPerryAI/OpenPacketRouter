import test from "node:test";
import assert from "node:assert/strict";
import {createSession} from "../src/index.js";
import {engineBackend} from "../src/backends/engine.js";
import {linuxCommands} from "../src/backends/linux.js";

const spec = () => ({format: "openpacketrouter.spec/1", name: "fwd", nodes: [
  {name: "R1", kind: "router", ifaces: {eth0: "10.0.0.1/24"}, lldp: {}}, {name: "R2", kind: "router", ifaces: {eth0: "10.0.0.2/24"}, lldp: {}},
  {name: "SW", kind: "switch"}], links: [["R1:eth0", "SW:p1"], ["R2:eth0", "SW:p2"]]});

test("lldp forward on a switch lets routers see each other; round-trips; linux group_fwd_mask", () => {
  const b = engineBackend(spec());
  const r1 = () => createSession(b, "R1", {mode: "priv"}).exec("show lldp neighbors | json").json;
  assert.equal(r1().length, 0);
  const sw = createSession(b, "SW", {mode: "config"});
  assert.equal(sw.exec("lldp forward").output, "");
  assert.equal(b.spec().nodes.find(n => n.name === "SW").forwardLldp, true);
  assert.equal(r1()[0].sysName, "R2");
  assert.match(createSession(b, "SW", {mode: "priv"}).exec("show running-config").output, /^lldp forward$/m);
  assert.ok(linuxCommands(b.getConfig("SW"), {kind: "switch", ports: b.ports("SW")}).some(l => /group_fwd_mask 0x4000/.test(l)));
  createSession(b, "SW", {mode: "config"}).exec("no lldp forward");
  assert.equal(b.spec().nodes.find(n => n.name === "SW").forwardLldp, undefined);
});
