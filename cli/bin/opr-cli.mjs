#!/usr/bin/env node
// opr-cli: a console on one device of an OpenPacketRouter spec.
//
//   opr-cli SPEC DEVICE                         interactive (? for help, Tab to complete, Ctrl-Z / end to leave config)
//   opr-cli SPEC DEVICE -c "enable" -c "show ip route | json"     run commands, print each with its output
//   printf 'enable\nconf t\nhostname CORE\nend\nwrite\n' | opr-cli SPEC DEVICE                   commands from stdin
//   opr-cli SPEC DEVICE --json -c ...           one JSON array: [{command, output, json?}], for scripts
//   opr-cli SPEC DEVICE --render linux|frr|openwrt   what the device's configuration looks like on that system
//                                               (--lab-parity with linux: also the settings that make the kernel's
//                                               frames match the engine's, as the validators use)
//
// `write` saves the changed spec back to SPEC. Exit code: 0 ok, 1 a command was refused, 2 usage or file error.
import fs from "node:fs";
import readline from "node:readline";
import {createSession} from "../src/index.js";
import {parseData, dumpYaml} from "../../engine/src/yaml.js";
import {engineBackend} from "../src/backends/engine.js";
import {linuxCommands} from "../src/backends/linux.js";
import {frrConfig} from "../src/backends/frr.js";
import {uciCommands} from "../src/backends/openwrt.js";

const USAGE = "usage: opr-cli SPEC DEVICE [-c COMMAND]... [--json] [--render linux|frr|openwrt [--lab-parity]]";
const argv = process.argv.slice(2), cmds = [], pos = [];
let json = false, render = null, labParity = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-c") cmds.push(argv[++i] ?? "");
  else if (a === "--json") json = true;
  else if (a === "--render") render = argv[++i];
  else if (a === "--lab-parity") labParity = true;
  else if (a === "-h" || a === "--help") { console.log(USAGE); process.exit(0); }
  else pos.push(a);
}
if (pos.length !== 2) { console.error(USAGE); process.exit(2); }
const [file, device] = pos;
let spec;
try { spec = parseData(fs.readFileSync(file, "utf8"), file); } catch (e) { console.error(`opr-cli: ${file}: ${e.message}`); process.exit(2); }
const backend = engineBackend(spec, {save: s => { fs.writeFileSync(file, /\.ya?ml$/i.test(file) ? dumpYaml(s) : JSON.stringify(s, null, 1) + "\n"); return true; }});
if (!backend.kind(device)) { console.error(`opr-cli: no device named ${device} in ${file} (devices: ${backend.devices().join(", ")})`); process.exit(2); }

if (render) {
  const model = backend.getConfig(device), opts = {kind: backend.kind(device), ports: backend.ports(device), labParity};
  const out = {linux: () => linuxCommands(model, opts).join("\n"), frr: () => frrConfig(model, opts), openwrt: () => uciCommands(model, opts).join("\n")}[render];
  if (!out) { console.error(USAGE); process.exit(2); }
  console.log(out()); process.exit(0);
}

const session = createSession(backend, device);

async function batch(lines) {
  const results = []; let refused = false;
  for (const line of lines) {
    const p = session.prompt(), r = session.exec(line);
    if (/^%|\n%/.test(r.output)) refused = true;
    if (json) results.push({command: line, prompt: p, output: r.output, ...(r.json !== undefined ? {json: r.json} : {})});
    else console.log(`${p}${line}${r.output ? "\n" + r.output : ""}`);
    if (session.closed) break;
  }
  if (json) console.log(JSON.stringify(results, null, 2));
  process.exit(refused ? 1 : 0);
}

if (cmds.length) batch(cmds);
else if (!process.stdin.isTTY) {
  let buf = ""; process.stdin.setEncoding("utf8");
  process.stdin.on("data", d => { buf += d; });
  process.stdin.on("end", () => batch(buf.split(/\r?\n/).filter(l => l.trim())));
} else {
  console.log(`${device}: OpenPacketRouter CLI. Type ? for help, Tab to complete, exit to leave.\n`);
  const rl = readline.createInterface({input: process.stdin, output: process.stdout, prompt: session.prompt(),
    completer: line => { const word = line.match(/\S*$/)[0]; return [word ? session.complete(line).options : [], word]; }});
  const tty = rl._ttyWrite.bind(rl);
  rl._ttyWrite = (s, key) => {
    if (s === "?") { process.stdout.write("?\n" + session.help(rl.line + "?") + "\n"); rl.prompt(true); return; }
    if (key && key.ctrl && key.name === "z") { rl.write(null, {ctrl: true, name: "u"}); rl.write("end\n"); return; }
    tty(s, key);
  };
  rl.prompt();
  rl.on("line", line => {
    const r = session.exec(line);
    if (r.output) console.log(r.output);
    if (session.closed) { rl.close(); return; }
    rl.setPrompt(session.prompt()); rl.prompt();
  });
  rl.on("close", () => process.exit(0));
}
