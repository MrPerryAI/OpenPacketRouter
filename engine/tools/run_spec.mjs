// Run a list of actions on a network spec and print, per action, the result and
// the number of frames sent on every cable direction ("A:if>B:if": n).
//   node tools/run_spec.mjs spec.json actions.json
// Caches (ARP, switch MAC tables) are flushed before every action, so each
// action starts cold and its frame counts don't depend on the order of actions.
import fs from "node:fs";
import {Network, ping, traceroute, dns, udpRequest} from "../src/index.js";

const [specFile, actionsFile] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specFile, "utf8"));
const actions = JSON.parse(fs.readFileSync(actionsFile, "utf8"));
const net = Network.fromSpec(spec);
const out = [];
for (const a of actions) {
  net.flushCaches();
  const before = net.snapshot();
  let result;
  if (a.do === "ping") result = ping(net, a.src, a.dst, {ttl: a.ttl ?? 64, timeout: a.timeout ?? 2});
  else if (a.do === "traceroute") result = traceroute(net, a.src, a.dst, {maxHops: a.maxHops ?? 8});
  else if (a.do === "dns") result = dns(net, a.src, a.server, a.name);
  else if (a.do === "udp") result = udpRequest(net, a.src, a.dst, a.port, {probe: true});
  else throw new Error(`unknown action ${a.do}`);
  net.settle(a.settle ?? 1);
  out.push({action: a, result, frames: net.diff(before)});
}
process.stdout.write(JSON.stringify(out, null, 1));
