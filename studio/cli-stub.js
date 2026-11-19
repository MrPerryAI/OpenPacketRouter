// A small Cisco-style command line for one device, used by the Studio console until the project's cli/ package
// exists. It edits the spec (the network's configuration) and asks the page to run the engine again.
//
// Interface (kept small so a real cli/ package can replace this file):
//   createSession(env, device) -> {prompt(), exec(line) -> {output, changed}, complete(line) -> {line, options}, help(line) -> string}
//   env: {spec(), setSpec(spec) -> errors[], actions(), setActions(list), cut: Set<link index>, setCut(), state(device), routes(device),
//         run(action) -> result}   (run: one engine action, e.g. a ping, added to the playback)
//   changed: null | "spec" | "cut" | "actions"  (what the page must redraw)
//
// Modes and prompts: R1> (user), R1# (enable), R1(config)#, R1(config-if)#. Words may be abbreviated to any
// unique prefix ("conf t", "sh ip ro"); "?" lists what can come next; Tab completes a word; "do" runs an
// enable-mode command from configuration mode.

const IP_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const isIp = s => IP_RE.test(s) && s.split(".").every(o => +o <= 255);
const maskToPrefix = m => { if (!isIp(m)) return null; const n = m.split(".").reduce((a, o) => a * 256 + +o, 0);
  const bits = n.toString(2).padStart(32, "0"); return /^1*0*$/.test(bits) ? bits.indexOf("0") === -1 ? 32 : bits.indexOf("0") : null; };
const prefixToMask = p => { const n = p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0; return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."); };
const netOf = (ip, p) => { const n = ip.split(".").reduce((a, o) => a * 256 + +o, 0), m = p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0, x = (n & m) >>> 0;
  return [x >>> 24, (x >>> 16) & 255, (x >>> 8) & 255, x & 255].join("."); };
const clone = o => JSON.parse(JSON.stringify(o));
const pad = (s, n) => String(s ?? "").padEnd(n);

// argument types: [placeholder shown by ?, help, test]
const ARG = {
  "<ip>": ["A.B.C.D", "IP address", isIp],
  "<mask>": ["A.B.C.D", "Subnet mask", m => maskToPrefix(m) !== null],
  "<vlan>": ["<1-4094>", "VLAN ID", s => /^\d+$/.test(s) && +s >= 1 && +s <= 4094],
  "<vlans>": ["WORD", "VLAN IDs, like 10,20", s => /^\d+(,\d+)*$/.test(s)],
  "<num>": ["<0-65535>", "Number", s => /^\d+$/.test(s) && +s <= 65535],
  "<name>": ["WORD", "Name", s => /^[A-Za-z][\w-]*$/.test(s)],
  "<host>": ["WORD", "Address or name", s => s.length > 0],
};

/** Commands: [mode(s), pattern, run, help per literal word]. Lower-case literals; <iface> and the ARG names are arguments. */
function commands(kind) {
  const L = [];
  const add = (modes, pattern, run, help = {}) => L.push({modes: modes.split(" "), pattern: pattern.split(" "), run, help});
  const sw = kind === "switch", ipn = !sw;
  add("user", "enable", s => { s.mode = "priv"; }, {enable: "Turn on privileged commands"});
  add("user priv", "exit", s => { s.closed = true; return "Connection closed."; }, {exit: "Exit from the EXEC"});
  add("priv", "disable", s => { s.mode = "user"; }, {disable: "Turn off privileged commands"});
  add("priv", "configure terminal", s => { s.mode = "config"; return "Enter configuration commands, one per line.  End with CNTL/Z."; },
    {configure: "Enter configuration mode", terminal: "Configure from the terminal"});
  add("user priv", "show running-config", s => runningConfig(s), {show: "Show running system information", "running-config": "Current operating configuration"});
  add("user priv", "show ip interface brief", s => showIpIntBrief(s), {ip: "IP information", interface: "IP interface status and configuration", brief: "Brief summary of IP status"});
  if (ipn) {
    add("user priv", "show ip route", s => showIpRoute(s), {route: "IP routing table"});
    add("user priv", "show arp", s => showArp(s), {arp: "ARP table"});
    add("user priv", "ping <ip>", (s, a) => ping(s, a[0]), {ping: "Send echo messages"});
    add("user priv", "traceroute <ip>", (s, a) => traceroute(s, a[0]), {traceroute: "Trace route to destination"});
  }
  if (sw) {
    add("user priv", "show mac address-table", s => showMac(s), {mac: "MAC configuration", "address-table": "MAC forwarding table"});
    add("user priv", "show spanning-tree", s => showStp(s), {"spanning-tree": "Spanning tree topology"});
    add("user priv", "show vlan brief", s => showVlan(s), {vlan: "VLAN information", brief: "VLAN summary information"});
  }
  // configuration
  add("config config-if", "end", s => { s.mode = "priv"; s.iface = null; }, {end: "Exit to privileged EXEC mode"});
  add("config", "exit", s => { s.mode = "priv"; }, {exit: "Exit from configure mode"});
  add("config-if", "exit", s => { s.mode = "config"; s.iface = null; }, {exit: "Exit from interface configuration mode"});
  add("config", "hostname <name>", (s, a) => hostname(s, a[0]), {hostname: "Set system's network name"});
  add("config config-if", "interface <iface>", (s, a) => { s.mode = "config-if"; s.iface = a[0]; }, {interface: "Select an interface to configure"});
  add("config-if", "shutdown", s => shut(s, true), {shutdown: "Shutdown the selected interface"});
  add("config-if", "no shutdown", s => shut(s, false), {no: "Negate a command or set its defaults"});
  if (ipn) {
    add("config", "ip route <ip> <mask> <ip>", (s, a) => route(s, a, true), {ip: "Global IP configuration subcommands", route: "Establish static routes"});
    add("config", "no ip route <ip> <mask> <ip>", (s, a) => route(s, a, false), {no: "Negate a command or set its defaults"});
    add("config", "ip default-gateway <ip>", (s, a) => gateway(s, a[0]), {"default-gateway": "Specify default gateway"});
    add("config", "no ip default-gateway", s => gateway(s, null));
    add("config-if", "ip address <ip> <mask>", (s, a) => address(s, `${a[0]}/${maskToPrefix(a[1])}`), {ip: "Interface Internet Protocol config commands", address: "Set the IP address of an interface"});
    add("config-if", "ip address dhcp", s => address(s, "dhcp"), {dhcp: "IP Address negotiated via DHCP"});
    add("config-if", "no ip address", s => address(s, null));
  }
  if (sw) {
    add("config", "spanning-tree", s => stp(s, {}), {"spanning-tree": "Spanning Tree Subsystem"});
    add("config", "no spanning-tree", s => stp(s, null));
    add("config", "spanning-tree vlan <vlan> priority <num>", (s, a) => stp(s, {priority: +a[1]}), {vlan: "VLAN Switch Spanning Tree", priority: "Set the bridge priority for the spanning tree"});
    add("config-if", "switchport mode access", s => vcfg(s, () => ({access: 1})), {switchport: "Set switching mode characteristics", mode: "Set trunking mode of the interface", access: "Set trunking mode to ACCESS unconditionally"});
    add("config-if", "switchport mode trunk", s => vcfg(s, (c, all) => ({trunk: all})), {trunk: "Set trunking mode to TRUNK unconditionally"});
    add("config-if", "switchport access vlan <vlan>", (s, a) => vcfg(s, () => ({access: +a[0]})), {access: "Set access mode characteristics of the interface", vlan: "Set VLAN when interface is in access mode"});
    add("config-if", "switchport trunk allowed vlan <vlans>", (s, a) => vcfg(s, c => ({...trunkOf(c), trunk: a[0].split(",").map(Number)})),
      {trunk: "Set trunking characteristics of the interface", allowed: "Set allowed VLAN characteristics when interface is in trunking mode", vlan: "Set allowed VLANs"});
    add("config-if", "switchport trunk native vlan <vlan>", (s, a) => vcfg(s, c => ({...trunkOf(c), native: +a[0]})), {native: "Set trunking native characteristics", vlan: "Set native VLAN"});
    add("config-if", "spanning-tree cost <num>", (s, a) => portStp(s, "cost", +a[0]), {"spanning-tree": "Spanning Tree Subsystem", cost: "Change an interface's spanning tree port path cost"});
    add("config-if", "spanning-tree port-priority <num>", (s, a) => portStp(s, "portPriority", +a[0]), {"port-priority": "Change an interface's spanning tree port priority"});
  }
  // help for a word: what the commands of the same mode say about it, else any command's
  const any = {}, byMode = {};
  for (const c of L) for (const [w, h] of Object.entries(c.help)) { any[w] ||= h; for (const m of c.modes) (byMode[m] ||= {})[w] ||= h; }
  L.helpFor = (mode, w) => (byMode[mode] || {})[w] || any[w] || "";
  return L;
}
const trunkOf = c => c && c.trunk ? {trunk: c.trunk, ...(c.native !== undefined ? {native: c.native} : {})} : {trunk: [1]};

// ---------------------------------------------------------------- session

export function createSession(env, device) {
  const s = {env, device, mode: "user", iface: null, closed: false, history: []};
  const node = () => env.spec().nodes.find(n => n.name === s.device);
  const kind = node().kind;
  const cmds = commands(kind);
  s.node = node;
  s.ifaces = () => kind === "switch"
    ? env.spec().links.flat().filter(r => typeof r === "string" && r.startsWith(s.device + ":")).map(r => r.split(":")[1])
    : Object.keys(node().ifaces || {});

  const modeFor = toks => (s.mode !== "user" && s.mode !== "priv" && toks.length && "do".startsWith(toks[0].toLowerCase()) && toks[0].length >= 2)
    ? {mode: "priv", toks: toks.slice(1)} : {mode: s.mode, toks};
  const argOk = (pat, tok) => pat === "<iface>" ? s.ifaces().includes(tok) : ARG[pat] ? ARG[pat][2](tok) : false;
  const isLit = pat => !pat.startsWith("<");

  /** Commands that still match the tokens typed so far (the last token may be partial when `partial`). */
  function candidates(mode, toks, partial) {
    return cmds.filter(c => c.modes.includes(mode) && c.pattern.length >= toks.length && toks.every((t, i) => {
      const p = c.pattern[i]; const last = partial && i === toks.length - 1;
      if (isLit(p)) return p.startsWith(t.toLowerCase());
      return last ? (p === "<iface>" ? s.ifaces().some(f => f.startsWith(t)) || argOk(p, t) : true) : argOk(p, t);
    }));
  }
  /** Interface names: exact, or a unique prefix (Cisco lets you type "gi0" for "gi0/1"). */
  const fixIface = (c, toks) => toks.map((t, i) => c.pattern[i] === "<iface>" && !s.ifaces().includes(t)
    && s.ifaces().filter(f => f.startsWith(t)).length === 1 ? s.ifaces().find(f => f.startsWith(t)) : t);

  function exec(line) {
    const text = line.trim(); if (!text) return {output: "", changed: null};
    s.history.push(text);
    if (text.endsWith("?")) return {output: help(text), changed: null};
    const {mode, toks} = modeFor(text.split(/\s+/));
    let cs = candidates(mode, toks, true).map(c => ({c, toks: fixIface(c, toks)}))
      .filter(({c, toks: t}) => c.pattern.length === t.length && t.every((x, i) => isLit(c.pattern[i]) || argOk(c.pattern[i], x)));
    if (!cs.length) {
      const any = candidates(mode, toks, true);
      if (any.length) return {output: "% Incomplete command.", changed: null};
      const bad = toks.findIndex((_, i) => !candidates(mode, toks.slice(0, i + 1), true).length);
      return {output: `% Invalid input detected at '^' marker.\n${" ".repeat(prompt().length + text.indexOf(toks[bad] ?? ""))}^`, changed: null};
    }
    if (cs.length > 1) {   // two commands match: prefer the one whose literals were typed in full, else ambiguous
      const exact = cs.filter(({c, toks: t}) => t.every((x, i) => !isLit(c.pattern[i]) || c.pattern[i] === x.toLowerCase()));
      if (exact.length === 1) cs = exact; else return {output: `% Ambiguous command:  "${text}"`, changed: null};
    }
    const {c, toks: t} = cs[0];
    s.changed = null;
    const args = t.filter((_, i) => !isLit(c.pattern[i]));
    const savedMode = s.mode;
    if (mode !== s.mode) s.mode = mode;                      // "do": run in enable mode, then come back
    let out;
    try { out = c.run(s, args) ?? ""; } catch (e) { out = `% ${e.message}`; }
    if (mode !== savedMode && !s.closed) s.mode = savedMode;
    return {output: out, changed: s.changed};
  }

  function help(text) {
    const body = text.replace(/\?$/, ""); const trailing = !body.length || /\s$/.test(body);
    const {mode, toks} = modeFor(body.trim() ? body.trim().split(/\s+/) : []);
    const rows = new Map();
    if (trailing) {
      const i = toks.length;
      for (const c of candidates(mode, toks, false)) {
        if (c.pattern.length === i) rows.set("<cr>", "");
        else { const p = c.pattern[i];
          if (isLit(p)) rows.set(p, i === 0 ? cmds.helpFor(mode, p) : c.help[p] || cmds.helpFor(mode, p));
          else if (p === "<iface>") for (const f of s.ifaces()) rows.set(f, "Interface");
          else rows.set(ARG[p][0], ARG[p][1]); }
      }
    } else {
      const i = toks.length - 1;
      for (const c of candidates(mode, toks, true)) { const p = c.pattern[i];
        if (isLit(p)) rows.set(p, ""); else if (p === "<iface>") for (const f of s.ifaces().filter(f => f.startsWith(toks[i]))) rows.set(f, ""); }
      if (!rows.size) return "% Unrecognized command";
      return [...rows.keys()].sort().join("  ");
    }
    if (!rows.size) return "% Unrecognized command";
    const w = Math.max(...[...rows.keys()].map(k => k.length)) + 2;
    return [...rows].sort((a, b) => a[0] === "<cr>" ? 1 : b[0] === "<cr>" ? -1 : a[0] < b[0] ? -1 : 1).map(([k, v]) => `  ${pad(k, w)}${v}`).join("\n");
  }

  /** Tab: complete the last word when only one word fits. */
  function complete(line) {
    const m = /^(.*?)(\S*)$/.exec(line); const head = m[1], word = m[2];
    const {mode, toks} = modeFor((head + word).trim() ? (head + word).trim().split(/\s+/) : []);
    if (!word) return {line, options: []};
    const i = toks.length - 1, opts = new Set();
    for (const c of candidates(mode, toks, true)) { const p = c.pattern[i];
      if (isLit(p)) opts.add(p); else if (p === "<iface>") for (const f of s.ifaces()) if (f.startsWith(word)) opts.add(f); }
    const list = [...opts].sort();
    if (list.length === 1) return {line: head + list[0] + " ", options: list};
    let common = word; if (list.length) { common = list[0]; for (const o of list) while (!o.startsWith(common)) common = common.slice(0, -1); }
    return {line: head + (common.length > word.length ? common : word), options: list};
  }

  function prompt() {
    return s.device + ({user: ">", priv: "#", config: "(config)#", "config-if": "(config-if)#"})[s.mode];
  }
  return {exec, help, complete, prompt, get mode() { return s.mode; }, get closed() { return s.closed; }, get device() { return s.device; }, history: s.history};
}

// ---------------------------------------------------------------- configuration changes

/** Edit a copy of the spec; the page validates it and keeps it only when it is still a valid network. */
function edit(s, fn) {
  const spec = clone(s.env.spec()); const n = spec.nodes.find(x => x.name === s.device);
  const msg = fn(n, spec);
  const errs = s.env.setSpec(spec);
  if (errs && errs.length) throw new Error(errs[0]);
  s.changed = "spec";
  return msg;
}

function hostname(s, name) {
  if (s.env.spec().nodes.some(n => n.name === name && n.name !== s.device)) throw new Error(`${name} is already the name of another device`);
  const old = s.device;
  edit(s, (n, spec) => {
    n.name = name;
    spec.links = spec.links.map(l => l.map(x => typeof x === "string" && x.startsWith(old + ":") ? name + x.slice(old.length) : x));
  });
  s.env.setActions(s.env.actions().map(a => ({...a, ...(a.src === old ? {src: name} : {})})));
  s.device = name;
}

function linkIndex(s) { return s.env.spec().links.findIndex(l => l[0] === `${s.device}:${s.iface}` || l[1] === `${s.device}:${s.iface}`); }
function shut(s, down) {
  const i = linkIndex(s); if (i < 0) return `% ${s.iface} has no cable`;
  const cut = new Set(s.env.cut); if (down) cut.add(i); else cut.delete(i);
  s.env.setCut(cut); s.changed = "cut";
  return `%LINK-5-CHANGED: Interface ${s.iface}, changed state to ${down ? "administratively down" : "up"}`;
}

function route(s, [dst, mask, via], add) {
  const p = maskToPrefix(mask), cidr = `${netOf(dst, p)}/${p}`;
  return edit(s, n => {
    const r = (n.routes || []).filter(x => !(x[0] === cidr && (!via || x[1] === via)));
    if (add) r.push([cidr, via]);
    else if (r.length === (n.routes || []).length) throw new Error("No matching route to delete");
    n.routes = r; if (!r.length) delete n.routes;
  });
}
function gateway(s, ip) { return edit(s, n => { if (ip) n.gw = ip; else delete n.gw; }); }
function address(s, value) {
  return edit(s, n => { n.ifaces = n.ifaces || {};
    if (value === null) { if (!(s.iface in n.ifaces)) throw new Error("No address to remove"); throw new Error("Interfaces without an address are not in the spec format yet"); }
    n.ifaces[s.iface] = value; });
}
function stp(s, opts) {
  return edit(s, n => {
    if (opts === null) delete n.stp;
    else n.stp = {...(n.stp || {}), ...opts};
  });
}
function vcfg(s, fn) {
  return edit(s, (n, spec) => {
    const all = new Set([1]);
    for (const x of spec.nodes) if (x.vlans) for (const c of Object.values(x.vlans)) { if (c.access) all.add(c.access); for (const v of c.trunk || []) all.add(v); }
    n.vlans = n.vlans || {};
    n.vlans[s.iface] = fn(n.vlans[s.iface], [...all].sort((a, b) => a - b));
  });
}
function portStp(s, key, v) {
  return edit(s, n => { if (!n.stp) throw new Error("Spanning tree is off on this switch (configure: spanning-tree)");
    n.stp[key] = {...(n.stp[key] || {}), [s.iface]: v}; });
}

// ---------------------------------------------------------------- show and ping

function runningConfig(s) {
  const n = s.node(), out = ["Building configuration...", "", "Current configuration:", "!", `hostname ${n.name}`, "!"];
  if (n.kind === "switch") {
    if (n.stp) { out.push("spanning-tree"); if (n.stp.priority !== undefined) out.push(`spanning-tree vlan 1 priority ${n.stp.priority}`); out.push("!"); }
    for (const p of s.ifaces()) {
      out.push(`interface ${p}`);
      const c = n.vlans && n.vlans[p];
      if (c && c.trunk) { out.push(" switchport mode trunk", ` switchport trunk allowed vlan ${c.trunk.join(",")}`); if (c.native !== undefined) out.push(` switchport trunk native vlan ${c.native}`); }
      else if (c && c.access !== 1) out.push(" switchport mode access", ` switchport access vlan ${c.access}`);
      if (n.stp && n.stp.cost && n.stp.cost[p] !== undefined) out.push(` spanning-tree cost ${n.stp.cost[p]}`);
      if (n.stp && n.stp.portPriority && n.stp.portPriority[p] !== undefined) out.push(` spanning-tree port-priority ${n.stp.portPriority[p]}`);
      if ((n.blocked || []).includes(p)) out.push(" ! blocked in the spec");
      if (isCut(s, p)) out.push(" shutdown");
      out.push("!");
    }
  } else {
    for (const [i, a] of Object.entries(n.ifaces || {})) {
      out.push(`interface ${i}`, a === "dhcp" ? " ip address dhcp" : ` ip address ${a.split("/")[0]} ${prefixToMask(+a.split("/")[1])}`);
      if (isCut(s, i)) out.push(" shutdown");
      out.push("!");
    }
    for (const [dst, via] of n.routes || []) out.push(`ip route ${dst.split("/")[0]} ${prefixToMask(+dst.split("/")[1])} ${via}`);
    if (n.gw) out.push(n.kind === "router" ? `ip route 0.0.0.0 0.0.0.0 ${n.gw}` : `ip default-gateway ${n.gw}`);
  }
  out.push("!", "end");
  return out.join("\n");
}
const isCut = (s, iface) => { const i = s.env.spec().links.findIndex(l => l[0] === `${s.device}:${iface}` || l[1] === `${s.device}:${iface}`); return i >= 0 && s.env.cut.has(i); };

function showIpIntBrief(s) {
  const n = s.node(), st = s.env.state(s.device) || {};
  const rows = [`${pad("Interface", 23)}${pad("IP-Address", 16)}${pad("OK?", 4)}${pad("Method", 7)}${pad("Status", 22)}Protocol`];
  for (const i of s.ifaces()) {
    const cabled = s.env.spec().links.some(l => l[0] === `${s.device}:${i}` || l[1] === `${s.device}:${i}`);
    const addr = n.kind === "switch" ? "unassigned" : ((st.ifaces || []).find(x => x.name === i)?.ip || "").split("/")[0] || "unassigned";
    const status = isCut(s, i) ? "administratively down" : cabled ? "up" : "down";
    rows.push(`${pad(i, 23)}${pad(addr, 16)}${pad("YES", 4)}${pad(n.ifaces && n.ifaces[i] === "dhcp" ? "DHCP" : "manual", 7)}${pad(status, 22)}${status === "up" ? "up" : "down"}`);
  }
  return rows.join("\n");
}

function showIpRoute(s) {
  const rows = s.env.routes(s.device) || [];
  const out = ["Codes: C - connected, S - static", ""];
  const def = rows.find(r => r.dst === "0.0.0.0/0");
  out.push(def ? `Gateway of last resort is ${def.via} to network 0.0.0.0` : "Gateway of last resort is not set", "");
  for (const r of rows) out.push(r.via === "connected" ? `C    ${r.dst} is directly connected, ${r.iface}` : `S${r.dst === "0.0.0.0/0" ? "*" : " "}   ${r.dst} [1/0] via ${r.via}`);
  return out.join("\n");
}
function showArp(s) {
  const a = (s.env.state(s.device) || {}).arp || [];
  return [`${pad("Protocol", 10)}${pad("Address", 17)}${pad("Hardware Addr", 19)}Interface`, ...a.map(e => `${pad("Internet", 10)}${pad(e.ip, 17)}${pad(e.mac, 19)}${e.iface}`)].join("\n");
}
function showMac(s) {
  const m = (s.env.state(s.device) || {}).mac || [];
  return ["          Mac Address Table", "-------------------------------------------", `${pad("Vlan", 8)}${pad("Mac Address", 20)}${pad("Type", 10)}Ports`,
    ...m.map(e => `${pad(e.vlan || 1, 8)}${pad(e.mac, 20)}${pad("DYNAMIC", 10)}${e.port}`), `Total Mac Addresses for this criterion: ${m.length}`].join("\n");
}
function showStp(s) {
  const d = (s.env.state(s.device) || {}).stp;
  if (!d) return "No spanning tree instance exists.";
  const out = ["VLAN0001", "  Spanning tree enabled protocol ieee", `  Root ID    ${d.root}`, d.isRoot ? "             This bridge is the root" : `             Cost ${d.rootCost}, Port ${d.rootPort}`, "",
    `  Bridge ID  ${d.bridgeId}`, "", `${pad("Interface", 12)}${pad("Role", 6)}${pad("Sts", 5)}${pad("Cost", 9)}Prio.Nbr`, "-".repeat(44)];
  const role = r => ({root: "Root", designated: "Desg", blocked: "Altn", disabled: "Disa"})[r] || r;
  const sts = x => ({forwarding: "FWD", blocking: "BLK", listening: "LIS", learning: "LRN", disabled: "DIS"})[x] || x;
  for (const [p, x] of Object.entries(d.ports)) out.push(`${pad(p, 12)}${pad(role(x.role), 6)}${pad(sts(x.state), 5)}${pad(x.cost, 9)}${x.id >> 8}.${x.no}`);
  return out.join("\n");
}
function showVlan(s) {
  const n = s.node(), by = new Map();
  for (const p of s.ifaces()) { const c = (n.vlans && n.vlans[p]) || {access: 1}; if (c.access !== undefined) { if (!by.has(c.access)) by.set(c.access, []); by.get(c.access).push(p); } }
  const trunks = s.ifaces().filter(p => n.vlans && n.vlans[p] && n.vlans[p].trunk);
  const out = [`${pad("VLAN", 5)}${pad("Name", 33)}${pad("Status", 10)}Ports`, "---- -------------------------------- --------- -------------------------------"];
  for (const v of [...by.keys()].sort((a, b) => a - b)) out.push(`${pad(v, 5)}${pad(v === 1 ? "default" : `VLAN${String(v).padStart(4, "0")}`, 33)}${pad("active", 10)}${by.get(v).join(", ")}`);
  if (trunks.length) out.push("", `Trunks: ${trunks.map(p => `${p} (${n.vlans[p].trunk.join(",")})`).join(", ")}`);
  return out.join("\n");
}

function ping(s, ip) {
  const r = s.env.run({do: "ping", src: s.device, dst: ip}); s.changed = "actions";
  const ok = r && r.ok;
  return [`Type escape sequence to abort.`, `Sending 1, 100-byte ICMP Echos to ${ip}, timeout is 2 seconds:`, ok ? "!" : ".",
    `Success rate is ${ok ? 100 : 0} percent (${ok ? 1 : 0}/1)${ok ? `, round-trip min/avg/max = ${r.rtt_ms}/${r.rtt_ms}/${r.rtt_ms} ms` : ""}`,
    ...(!ok && r && r.error ? [`(${r.error}${r.from ? " from " + r.from : ""})`] : []), "(the frames are in the player: press ▶)"].join("\n");
}
function traceroute(s, ip) {
  const r = s.env.run({do: "traceroute", src: s.device, dst: ip}); s.changed = "actions";
  const out = ["Type escape sequence to abort.", `Tracing the route to ${ip}`, ""];
  (r.hops || []).forEach((h, i) => out.push(`  ${i + 1} ${h.from ?? "*"}${h.rtt_ms !== undefined ? ` ${h.rtt_ms} msec` : ""}`));
  return out.join("\n");
}
