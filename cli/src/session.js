// A CLI session on one device: modes, prompt, parsing, help, completion, pipes and `do`.
//
//   const s = createSession(backend, "R1");
//   s.exec("show ip route | json")  -> {output, changed, json?}   changed: null | "spec" (configuration) | "actions" (ping …)
//   s.help("show ip ?")             -> text listing what can come next
//   s.complete("sh")                -> {line: "show ", options: ["show"]}
//   s.prompt()                      -> "R1>"
//
// Every configuration command is all-or-nothing: the handler edits a copy of the model, the backend applies it,
// and if the backend refuses, the old configuration stays and the reason is printed.

import {compile, available, walk, nextChoices, completions} from "./parser.js";
import {HANDLERS} from "./handlers.js";
import {SHOWS} from "./show.js";
import {DEFINITIONS} from "../commands/index.js";
import {clone} from "./model.js";
import {TYPES} from "./types.js";

export const PROMPTS = {user: ">", priv: "#", config: "(config)#", "config-if": "(config-if)#", "config-router": "(config-router)#", "config-ospf": "(config-router)#", "config-ripng": "(config-router)#",
  "config-vlan": "(config-vlan)#", "config-dhcp": "(config-dhcp)#", "config-acl": "(config-acl)#"};
const CONFIG_MODES = new Set(["config", "config-if", "config-router", "config-ospf", "config-ripng", "config-vlan", "config-dhcp", "config-acl"]);

const compiled = new WeakMap();
const tableFor = defs => { if (!compiled.has(defs)) compiled.set(defs, compile(defs)); return compiled.get(defs); };

export function createSession(backend, device, {definitions = DEFINITIONS, mode = "user"} = {}) {
  const table = tableFor(definitions);
  const s = {device, mode, iface: null, pool: null, vlan: null, router: null, closed: false, history: []};
  const kind = () => backend.kind(s.device);
  const ctx = () => ({ports: () => backend.ports(s.device), canCreatePorts: backend.canCreatePorts ? backend.canCreatePorts(s.device) : false});

  /** "do …" in a configuration mode runs a privileged command. */
  const split = words => CONFIG_MODES.has(s.mode) && words.length && words[0].toLowerCase() === "do" ? {mode: "priv", words: words.slice(1)} : {mode: s.mode, words};
  const cmdsFor = m => available(table, m, kind());
  const errorText = (r, words, text, cmds) => {
    if (r.error === "ambiguous") return `% Ambiguous: "${words[r.at]}" could be ${r.options.join(", ")}`;
    const before = walk(cmds, words.slice(0, r.at), ctx());
    if (!before.error && before.live.some(x => x.c.tokens[r.at]?.type === TYPES.ifname))
      return `% No interface ${words[r.at]} on ${s.device} (it has ${backend.ports(s.device).join(", ") || "none"})`;
    const col = text.indexOf(words[r.at], words.slice(0, r.at).join(" ").length);
    return `${" ".repeat(prompt().length + Math.max(0, col))}^\n% Unknown word at '^'`;
  };

  function run(c, values, m) {
    const cut = c.handler.indexOf(":"), name = cut < 0 ? c.handler : c.handler.slice(0, cut), param = cut < 0 ? undefined : c.handler.slice(cut + 1);
    if (name.startsWith("show.")) {
      const model = backend.getConfig(s.device);
      return {kind: "show", ...SHOWS[name]({model, kind: kind(), device: s.device, backend, ports: () => backend.ports(s.device), state: () => backend.state(s.device) || {}}, values, param)};
    }
    if (name.startsWith("session.") || name.startsWith("tools.")) return SESSION[name](values, param, m);
    const h = HANDLERS[name];
    if (!h) return {out: `% No handler ${name} (a bug in the command definitions)`};
    const before = backend.getConfig(s.device), model = clone(before);
    const sel = {iface: s.iface, pool: s.pool, vlan: s.vlan, router: s.router, acl: s.acl};
    try { h({model, s: sel, kind: kind()}, values, param); } catch (e) { return {out: `% ${e.message}`}; }
    let changed = null;
    if (JSON.stringify(model) !== JSON.stringify(before)) {
      const errs = backend.setConfig(s.device, model);
      if (errs.length) return {out: errs.map(e => `% ${e}`).join("\n")};
      changed = "spec";
      if (model.system.config.hostname !== s.device) s.device = model.system.config.hostname;
    }
    Object.assign(s, sel);
    if (c.enter) s.mode = c.enter;
    return {changed};
  }

  const SESSION = {
    "session.enable": () => { s.mode = "priv"; return {}; },
    "session.disable": () => { s.mode = "user"; return {}; },
    "session.configure": () => { s.mode = "config"; return {out: "Configuring from the terminal. Type end or press Ctrl-Z to finish."}; },
    "session.exit": () => {
      if (s.mode === "user" || s.mode === "priv") { s.closed = true; return {out: "Session closed."}; }
      if (s.mode === "config") s.mode = "priv"; else { s.mode = "config"; s.iface = s.pool = s.vlan = s.router = s.acl = null; }
      return {};
    },
    "session.end": () => { s.mode = "priv"; s.iface = s.pool = s.vlan = s.router = s.acl = null; return {}; },
    "session.write": () => {
      if (!backend.save) return {out: "% Nowhere to save to: this console was started without a file"};
      return {out: backend.save() === false ? "% Saving failed" : "Configuration saved."};
    },
    "tools.ping": ([ip]) => {
      let r; try { r = backend.run ? backend.run(s.device, {do: "ping", dst: ip}) : null; } catch (e) { return {out: `% ${e.message}`}; }
      if (!r) return {out: "% This backend cannot run ping"};
      const text = r.ok ? `Reply from ${r.from}: time ${r.rtt_ms} ms\nping ${ip}: 1 sent, 1 answered`
        : `${r.from ? `${r.from} says: ${r.error}` : `No answer (${r.error})`}\nping ${ip}: 1 sent, 0 answered`;
      return {out: text, changed: "actions", json: r};
    },
    "tools.traceroute": ([ip]) => {
      let r; try { r = backend.run ? backend.run(s.device, {do: "traceroute", dst: ip}) : null; } catch (e) { return {out: `% ${e.message}`}; }
      if (!r) return {out: "% This backend cannot run traceroute"};
      const lines = [`Route to ${ip}:`, ...(r.hops || []).map((h, i) => `${String(i + 1).padStart(3)}  ${h.from ?? "*"}${h.rtt_ms !== undefined ? `  ${h.rtt_ms} ms` : ""}`)];
      return {out: lines.join("\n"), changed: "actions", json: r};
    },
  };

  function exec(line) {
    const raw = String(line ?? ""); const text = raw.trim();
    if (!text || text.startsWith("!")) return {output: "", changed: null};
    s.history.push(text);
    if (text.endsWith("?")) return {output: help(text), changed: null};
    const [cmdText, ...pipes] = text.split(/\s+\|\s*/);
    const {mode, words} = split(cmdText.trim().split(/\s+/));
    if (!words.length) return {output: "% Command is incomplete", changed: null};
    let use = mode, r = walk(cmdsFor(mode), words, ctx());
    // A config-mode command typed in a sub-mode runs in config mode (and leaves the sub-mode).
    if ((r.error || !r.live.some(x => x.c.tokens.length === words.length)) && mode !== "config" && mode !== "priv" && CONFIG_MODES.has(mode)) {
      const r2 = walk(cmdsFor("config"), words, ctx());
      if (!r2.error && r2.live.some(x => x.c.tokens.length === words.length)) { r = r2; use = "config"; }
    }
    if (r.error) return {output: errorText(r, words, cmdText, cmdsFor(use)), changed: null};
    const full = r.live.filter(x => x.c.tokens.length === words.length);
    if (!full.length) return {output: "% Command is incomplete (type ? to see what comes next)", changed: null};
    const {c, values} = full[0];
    if (pipes.length && !c.handler.startsWith("show.") && !c.handler.startsWith("tools.")) return {output: "% Only show commands take | json, | include or | exclude", changed: null};

    const saved = s.mode;
    if (use === "config" && mode !== "config") { s.mode = "config"; s.iface = s.pool = s.vlan = s.router = s.acl = null; }
    let res = run(c, values, use);
    // ping and traceroute take the same pipes as show commands: their text and their JSON result.
    const changedByTool = c.handler.startsWith("tools.") ? res.changed : null;
    if (changedByTool && pipes.length) res = {kind: "show", text: res.out, json: res.json};
    if (mode === "priv" && saved !== "priv" && !s.closed && CONFIG_MODES.has(saved)) s.mode = saved;   // `do`: back where we were

    if (res.kind !== "show") return {output: res.out || "", changed: res.changed || null, ...(res.json ? {json: res.json} : {})};
    let out = res.text, json = res.json;
    for (const p of pipes) {
      const [pw, ...rest] = p.trim().split(/\s+/), arg = rest.join(" ");
      if ("json".startsWith(pw.toLowerCase()) && pw) out = JSON.stringify(json, null, 2);
      else if ("include".startsWith(pw.toLowerCase()) && pw && arg) out = out.split("\n").filter(l => l.includes(arg)).join("\n");
      else if ("exclude".startsWith(pw.toLowerCase()) && pw && arg) out = out.split("\n").filter(l => !l.includes(arg)).join("\n");
      else return {output: `% Unknown pipe "${p.trim()}": use | json, | include WORD or | exclude WORD`, changed: null};
    }
    return {output: out, changed: changedByTool, json};
  }

  function help(text) {
    const body = String(text).replace(/\?$/, ""), trailing = !body.trim() || /\s$/.test(body);
    if (/\|/.test(body)) return ["  json      The same data as JSON", "  include   Only lines that contain a word", "  exclude   Lines that do not contain a word"].join("\n");
    const all = body.trim() ? body.trim().split(/\s+/) : [];
    const {mode, words} = split(all);
    const cmds = cmdsFor(mode);
    if (trailing) {
      const r = nextChoices(table, mode, cmds, words, ctx());
      if (r.error) return r.error === "ambiguous" ? `% Ambiguous: "${words[r.at]}" could be ${r.options.join(", ")}` : "% Nothing matches that";
      if (!r.choices.length) return "% Nothing matches that";
      const w = Math.max(...r.choices.map(x => x.word.length)) + 2;
      return r.choices.map(x => `  ${x.word.padEnd(w)}${x.help}`.trimEnd()).join("\n");
    }
    const opts = completions(cmds, words.slice(0, -1), words[words.length - 1], ctx());
    return opts.length ? opts.join("  ") : "% Nothing matches that";
  }

  function complete(line) {
    const m = /^(.*?)(\S*)$/.exec(String(line)); const head = m[1], word = m[2];
    if (!word) return {line, options: []};
    const all = head.trim() ? head.trim().split(/\s+/) : [];
    const {mode, words} = split([...all, word]);
    const opts = completions(cmdsFor(mode), words.slice(0, -1), word, ctx());
    if (opts.length === 1) return {line: head + opts[0] + " ", options: opts};
    let common = opts[0] || word;
    for (const o of opts) while (!o.toLowerCase().startsWith(common.toLowerCase())) common = common.slice(0, -1);
    return {line: head + (common.length > word.length ? common : word), options: opts};
  }

  const prompt = () => s.device + PROMPTS[s.mode];
  return {
    exec, help, complete, prompt,
    get mode() { return s.mode; }, get device() { return s.device; }, get closed() { return s.closed; },
    get history() { return s.history; }, get selection() { return {iface: s.iface, pool: s.pool, vlan: s.vlan, router: s.router}; },
  };
}
