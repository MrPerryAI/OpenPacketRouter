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

test("frr rendering of IPv6 addresses, static routes and RIPng", () => {
  const spec = {nodes: [{name: "R1", kind: "router", ifaces6: {eth0: "2001:db8:1::1/64", eth1: "2001:db8:2::1/64"}, routes6: [["2001:db8:9::/64", "2001:db8:1::2"]],
    ripng: {networks: ["eth0", "eth1"], passive: ["eth1"], splitHorizon: "poisoned", timers: {update: 5, timeout: 15, garbage: 10}}}], links: []};
  const f = frrConfig(engineBackend(spec).getConfig("R1"));
  assert.match(f, /interface eth0\n ipv6 address 2001:db8:1::1\/64\n ipv6 ripng split-horizon poisoned-reverse\nexit/);
  assert.match(f, /\nipv6 route 2001:db8:9::\/64 2001:db8:1::2\n/);
  assert.match(f, /router ripng\n timers basic 5 15 10\n network eth0\n network eth1\n passive-interface eth1\nexit/);
  assert.doesNotMatch(frrConfig(engineBackend({nodes: [{name: "R1", kind: "router", ifaces6: {eth0: "2001:db8:1::1/64"}}], links: []}).getConfig("R1")), /router ripng/);
});
