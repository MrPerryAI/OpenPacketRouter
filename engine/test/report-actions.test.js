import test from "node:test";
import assert from "node:assert/strict";
import {describeResult} from "../src/report.js";

test("the text report describes vrrpState and lldpNeighbors instead of printing undefined", () => {
  const v = describeResult({do: "vrrpState", src: "R1"}, {t: 12.5, groups: [{iface: "eth0", vrid: 1, ip: "10.0.0.254", state: "master", masterIp: "10.0.0.1"}]});
  assert.equal(v, "VRRP on R1 at 12.5 s: eth0 group 1 (10.0.0.254) master, master 10.0.0.1");
  assert.equal(describeResult({do: "vrrpState", src: "H"}, {t: 0, groups: []}), "VRRP on H at 0 s: no groups");
  const l = describeResult({do: "lldpNeighbors", src: "S1"}, {t: 31, neighbors: [{iface: "p1", sysName: "S2", portDescr: "p3"}]});
  assert.equal(l, "LLDP neighbors of S1 at 31 s: p1 sees S2 (p3)");
  assert.ok(!/undefined/.test(describeResult({do: "lldpNeighbors", src: "S1"}, {t: 0, neighbors: []})));
});
