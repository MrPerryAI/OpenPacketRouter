// The FRR renderer for RIP: router rip, timers, networks, passive interfaces, split horizon per interface.
import test from "node:test";
import assert from "node:assert/strict";
import {engineBackend} from "../src/backends/engine.js";
import {frrConfig} from "../src/backends/frr.js";

test("frr rendering of a RIP spec", () => {
  const spec = {nodes: [{name: "R1", kind: "router", ifaces: {eth0: "10.0.0.1/24", eth1: "10.1.0.1/24"},
    rip: {networks: ["10.0.0.0/8"], passive: ["eth1"], splitHorizon: "poisoned", timers: {update: 5, timeout: 15, garbage: 10}}}], links: []};
  const f = frrConfig(engineBackend(spec).getConfig("R1"));
  assert.match(f, /interface eth0\n ip address 10\.0\.0\.1\/24\n ip rip split-horizon poisoned-reverse\nexit/);
  assert.match(f, /router rip\n version 2\n timers basic 5 15 10\n network 10\.0\.0\.0\/8\n passive-interface eth1\nexit/);
});

test("split horizon off, and no rip section without rip", () => {
  const rip = {nodes: [{name: "R1", kind: "router", ifaces: {eth0: "10.0.0.1/24"}, rip: {networks: ["10.0.0.0/8"], splitHorizon: "off"}}], links: []};
  assert.match(frrConfig(engineBackend(rip).getConfig("R1")), / no ip rip split-horizon/);
  const none = {nodes: [{name: "R1", kind: "router", ifaces: {eth0: "10.0.0.1/24"}}], links: []};
  assert.doesNotMatch(frrConfig(engineBackend(none).getConfig("R1")), /router rip/);
});
