// Storm math for a spec: node tools/storm.mjs spec.json        (or a {spec, capacities, host?} JSON on stdin)
// Prints stormAnalysis() as JSON. `capacities` (bits/s per link, in spec order) is for the parity test
// against poc/storm-math until link capacity is part of the spec format.
import fs from "node:fs";
import {Network, stormAnalysis, stormRates} from "../src/index.js";

const input = process.argv[2] ? {spec: JSON.parse(fs.readFileSync(process.argv[2], "utf8"))} : JSON.parse(fs.readFileSync(0, "utf8"));
const net = Network.fromSpec(input.spec);
(input.capacities || []).forEach((c, i) => { if (c) net.links[i].capacity = c; });
const {edges, ...rest} = stormAnalysis(net);
if (input.host) rest.steady = stormRates(net, input.host);   // per-cable storm rates after one broadcast (CIRCULATING only)
process.stdout.write(JSON.stringify(rest, null, 1) + "\n");
