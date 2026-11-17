// Run the Storm Lab's JavaScript engine (web/src/10-network.js + 20-engine.js)
// headlessly in Node on every lab scenario and print the results as JSON.
// Used by tests/test_parity.py to check the JS engine against poc/storm-math.
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = ["10-network.js", "20-engine.js"].map(f => fs.readFileSync(path.join(root, "web", "src", f), "utf8")).join("\n");
const ctx = vm.createContext({performance, Math, Object, Array, Set, Map, Float64Array, Uint8Array, Int32Array, Infinity, JSON});
vm.runInContext(src + `
function base() {
  for (const l of LINKS) S.link[l.id] = l.routedOnly ? "absent" : "up";
  for (const id of ["L14", "L15", "L16"]) S.link[id] = "absent";
  Object.assign(S.stp, {"NOC-SW": true, "ZFW-SW": true, "ZME-SW": true, "ZAB-SW": true, "AMA-SW": false, "ELD-OLD": false, "ELD-NEW": false});
  S.bpduPass = true; S.routed = false; S.broadcasts = [];
}
function snap(src) {
  buildModel();
  const hosts = [...M.reachDevs].filter(d => DEV[d].kind === "host").sort();
  const out = {rho: M.rho, regime: M.regime, doubling_ms: M.r ? Math.log(2) / M.r * 1000 : null, reach_hosts: hosts};
  if (M.regime === "CIRCULATING") { const {y} = steadyRates(src || "ZFW-VOICE"); const hostRates = {};
    M.edges.forEach((e, i) => { if (DEV[e.head].kind === "host" && y[i] > 0) hostRates[e.head] = y[i]; }); out.host_rates = hostRates; }
  return out;
}
var R = {};
base(); R["1-baseline"] = snap();
S.link.L14 = "up"; R["2-fiber"] = snap();
S.link.L15 = "up"; R["3a-xconA-core-sees"] = snap();
S.bpduPass = false; R["3b-xconA-core-blind"] = snap(); S.bpduPass = true;
S.link.L16 = "up"; R["4a-xconAB-core-sees"] = snap();
S.bpduPass = false; R["4b-xconAB-core-blind"] = snap(); S.bpduPass = true;
S.stp["ELD-OLD"] = S.stp["ELD-NEW"] = true; R["5-hardened"] = snap();
setRouted(true); S.stp["ELD-OLD"] = S.stp["ELD-NEW"] = false; R["6-routed-rebreak"] = snap("ELD-RADIO");
base(); S.bpduPass = false; for (const d of ["NOC-SW", "ZFW-SW", "ZME-SW", "ZAB-SW"]) S.stp[d] = false; R["7-core-stp-off"] = snap();
`, ctx);
process.stdout.write(JSON.stringify(ctx.R));
