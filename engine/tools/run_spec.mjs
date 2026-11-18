// Run a list of actions on a network spec and print, per action, the result and
// the number of frames sent on every cable direction ("A:if>B:if": n).
//   node tools/run_spec.mjs spec.json actions.json
// The validators (validate/*/run_kernel_*.py) read this output; keep it a bare JSON array.
// For people and agents, prefer the CLI: node bin/openpacketrouter.mjs run spec.json actions.json
import fs from "node:fs";
import {runActions} from "../src/spec.js";

const [specFile, actionsFile] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specFile, "utf8"));
const actions = JSON.parse(fs.readFileSync(actionsFile, "utf8"));
process.stdout.write(JSON.stringify(runActions(spec, actions), null, 1));
