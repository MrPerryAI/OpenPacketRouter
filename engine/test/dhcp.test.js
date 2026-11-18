import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {runActions, validateSpec} from "../src/index.js";

const spec = JSON.parse(fs.readFileSync(new URL("../../validate/dhcp/dhcp-lan.json", import.meta.url)));

test("DORA: two broadcasts out, two unicast answers back, no ARP", () => {
  assert.ok(validateSpec(spec).ok);
  const [r1, r2] = runActions(spec, [{do: "dhcp", src: "PC1"}, {do: "dhcp", src: "PC2"}], {trace: true});
  assert.deepEqual(r1.result, {ok: true, ip: "10.0.0.100", server: "10.0.0.1", lease: 3600});
  assert.equal(r1.frames["PC1:eth0>SW:p2"], 2);         // DISCOVER, REQUEST
  assert.equal(r1.frames["SW:p4>BYST:eth0"], 2);        // both broadcasts reach the bystander
  assert.equal(r1.frames["SRV:eth0>SW:p1"], 2);         // OFFER, ACK
  assert.equal(r1.frames["SW:p3>PC2:eth0"], 2);         // ... but the answers are unicast: PC2 sees only broadcasts
  assert.ok(!r1.trace.some(e => e.event === "arp-request"));
  // the pool has one address: PC2 tries three times and gives up
  assert.deepEqual(r2.result, {ok: false, error: "no offer"});
  assert.equal(r2.frames["PC2:eth0>SW:p3"], 3);
});

test("a bound client can use its address", () => {
  const [, r] = runActions(spec, [{do: "dhcp", src: "PC1"}, {do: "ping", src: "PC1", dst: "10.0.0.9"}]);
  assert.equal(r.result.ok, true);
});

test("through a relay: unicast to the server with giaddr, answers broadcast on the client LAN", () => {
  const relay = JSON.parse(fs.readFileSync(new URL("../../validate/dhcp/dhcp-relay.json", import.meta.url)));
  assert.ok(validateSpec(relay).ok);
  const [r] = runActions(relay, [{do: "dhcp", src: "PC1"}]);
  assert.deepEqual(r.result, {ok: true, ip: "10.1.0.100", server: "10.0.0.1", lease: 3600});
  assert.equal(r.frames["SWL:p3>LAN-B:eth0"], 4);       // DISCOVER, OFFER, REQUEST, ACK: all broadcast on the LAN
  assert.equal(r.frames["SWC:p3>CORE-B:eth0"], 1);      // only the router's ARP for the server reaches the core bystander
  assert.equal(r.frames["R:core>SWC:p1"], 3);           // ARP request + two relayed requests
});
