// The network spec format (version 1) and the action runner shared by the CLI and the validators.
//
// A spec is plain JSON:  {"version": 1, "name", "about", "nodes": [...], "links": [[aRef, bRef, delayMs?], ...]}
// An actions file is a JSON array: [{"do": "ping", "src", "dst", ...}, ...]
// docs/spec-format.md is the reference. `version` may be left out (it means 1), so every spec written
// before the format had a number still loads unchanged.
//
// Validation collects every problem (with a JSON path) instead of stopping at the first, so a person or
// an agent editing a spec can fix them all in one pass. Keys a later engine feature adds (VLANs, link
// capacity, DHCP …) are reported as warnings, not errors, until they are registered here.

import {Network} from "./network.js";
import {tcpAction} from "./tcp.js";
import {dhcp} from "./dhcp.js";
import {ping, traceroute, dns, udpRequest, syslogSend, FACILITIES, SEVERITIES, stackOf} from "./apps.js";
import {parseCidr, inSubnet} from "./addr.js";
import {parseRate, queueStats} from "./link.js";

export const SPEC_VERSION = 1;
export const RESULT_FORMAT = "openpacketrouter.result/1";

const KINDS = ["switch", "router", "host", "server"];
const NODE_KEYS = {
  common: ["name", "kind", "about"],
  switch: ["blocked", "stp", "vlans", "vlanNames", "ifaces", "routes", "gw", "agingTime", "channels", "forwardLldp", "portSecurity", "stormControl", "monitor"],   // forwardLldp: true lets LLDP frames through (bridge group_fwd_mask 0x4000);   // vlanNames: {"10": "sales"} (labels only); stp/vlans: engine/src/stp.js; ifaces = SVIs (Layer 3 switch)
  router: ["ifaces", "routes", "gw", "services", "ospf", "rip", "acl", "nat", "lldp"],      // ospf: engine/src/ospf.js, rip: engine/src/rip.js, acl: engine/src/acl.js, nat: engine/src/nat.js
  host: ["ifaces", "routes", "gw", "services", "lldp"],         // lldp: engine/src/lldp.js
  server: ["ifaces", "routes", "gw", "services", "lldp"],
};
/** Features add their node keys here: registerNodeKeys("switch", ["stp", "vlans"]). */
export function registerNodeKeys(kind, keys) { (NODE_KEYS[kind] ||= []).push(...keys); }

const isObj = x => x !== null && typeof x === "object" && !Array.isArray(x);
const IP_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const isIp = s => typeof s === "string" && IP_RE.test(s) && s.split(".").every(o => +o <= 255);
const isCidr = s => { if (typeof s !== "string") return false; const [ip, p, ...rest] = s.split("/");
  return !rest.length && isIp(ip) && /^\d{1,2}$/.test(p ?? "") && +p <= 32; };

// `ip link set NAME …` prefix-matches its keywords, so an interface named like the start of one ("a" →
// address, "b" → broadcast, "m" → mtu …) can't be built by the Linux validators. Warn early.
const IP_LINK_KEYWORDS = ["address", "broadcast", "mtu", "name", "netns", "master", "nomaster", "up", "down", "type",
  "dev", "group", "alias", "vf", "state", "arp", "multicast", "allmulticast", "promisc", "txqueuelen", "qlen", "link", "mode", "protodown", "xdp", "addrgenmode"];
const SUBIF_RE = /^([^.]+)\.(\d+)$/;
const ambiguousIfname = n => IP_LINK_KEYWORDS.find(k => k.startsWith(n));

const OSPF_IF_KEYS = {type: v => ["broadcast", "point-to-point"].includes(v), priority: v => Number.isInteger(v) && v >= 0 && v <= 255,
  cost: v => Number.isInteger(v) && v >= 1 && v <= 65535, hello: v => Number.isInteger(v) && v >= 1, dead: v => Number.isInteger(v) && v >= 1, retransmit: v => Number.isInteger(v) && v >= 1};
function checkOspf(n, p, err) {
  const o = n.ospf, names = Object.keys(isObj(n.ifaces) ? n.ifaces : {});
  if (!isObj(o)) return err(`${p}.ospf`, `node "${n.name}": ospf must be an object like {"networks": ["10.0.0.0/8"]}`);
  for (const k of Object.keys(o)) if (!["routerId", "networks", "passive", "interfaces"].includes(k)) err(`${p}.ospf.${k}`, `node "${n.name}": unknown ospf key "${k}" (routerId, networks, passive, interfaces)`);
  if (o.routerId !== undefined && !isIp(o.routerId)) err(`${p}.ospf.routerId`, `node "${n.name}": routerId "${o.routerId}" is not like 1.1.1.1`);
  if (!Array.isArray(o.networks) || !o.networks.length) err(`${p}.ospf.networks`, `node "${n.name}": ospf needs networks: interface names or prefixes like 10.0.0.0/8`);
  else o.networks.forEach((x, j) => { if (!(isCidr(x) || names.includes(x))) err(`${p}.ospf.networks[${j}]`, `node "${n.name}": "${x}" is neither one of its interfaces nor a prefix like 10.0.0.0/8`); });
  if (o.passive !== undefined && !(Array.isArray(o.passive) && o.passive.every(x => names.includes(x))))
    err(`${p}.ospf.passive`, `node "${n.name}": passive must list some of its interfaces (${names.join(", ")})`);
  if (o.interfaces !== undefined) {
    if (!isObj(o.interfaces)) return err(`${p}.ospf.interfaces`, `node "${n.name}": ospf.interfaces maps interface names to {type, priority, cost, hello, dead, retransmit}`);
    for (const [ifn, c] of Object.entries(o.interfaces)) {
      if (!names.includes(ifn)) err(`${p}.ospf.interfaces.${ifn}`, `node "${n.name}": ${ifn} is not one of its interfaces (${names.join(", ")})`);
      if (!isObj(c)) { err(`${p}.ospf.interfaces.${ifn}`, `node "${n.name}": ${ifn}: expected an object`); continue; }
      for (const [k, v] of Object.entries(c)) if (!OSPF_IF_KEYS[k]) err(`${p}.ospf.interfaces.${ifn}.${k}`, `node "${n.name}": unknown key "${k}" (${Object.keys(OSPF_IF_KEYS).join(", ")})`);
        else if (!OSPF_IF_KEYS[k](v)) err(`${p}.ospf.interfaces.${ifn}.${k}`, `node "${n.name}": ${ifn}: bad ${k} ${JSON.stringify(v)}`);
      if (c.hello !== undefined && c.dead !== undefined && c.dead <= c.hello) err(`${p}.ospf.interfaces.${ifn}.dead`, `node "${n.name}": ${ifn}: dead (${c.dead}) must be longer than hello (${c.hello})`);
    }
  }
}

const ACL_RULE_KEYS = ["action", "proto", "src", "dst", "sport", "dport", "icmpType", "established"];
const isAddrOrAny = x => x === "any" || (typeof x === "string" && (isIp(x) || isCidr(x)));
const isPortSpec = x => (Number.isInteger(x) && x >= 0 && x <= 65535) || (typeof x === "string" && /^\d+-\d+$/.test(x) && x.split("-").every(v => +v <= 65535) && +x.split("-")[0] <= +x.split("-")[1]);
function checkAcl(n, p, err) {
  const a = n.acl, names = Object.keys(isObj(n.ifaces) ? n.ifaces : {});
  if (!isObj(a)) return err(`${p}.acl`, `node "${n.name}": acl must be an object like {"lists": {...}, "bind": {...}}`);
  for (const k of Object.keys(a)) if (!["lists", "bind"].includes(k)) err(`${p}.acl.${k}`, `node "${n.name}": unknown acl key "${k}" (lists, bind)`);
  const lists = isObj(a.lists) ? a.lists : {};
  if (a.lists !== undefined && !isObj(a.lists)) err(`${p}.acl.lists`, `node "${n.name}": acl.lists maps a list name to an array of rules`);
  for (const [name, rules] of Object.entries(lists)) {
    const lp = `${p}.acl.lists.${name}`;
    if (!Array.isArray(rules)) { err(lp, `node "${n.name}": list ${name} must be an array of rules`); continue; }
    rules.forEach((r, j) => {
      const rp = `${lp}[${j}]`;
      if (!isObj(r)) return err(rp, `node "${n.name}": ${name}: a rule is an object like {"action": "permit", "proto": "tcp", "dport": 80}`);
      for (const k of Object.keys(r)) if (!ACL_RULE_KEYS.includes(k)) err(`${rp}.${k}`, `node "${n.name}": ${name}: unknown rule key "${k}" (${ACL_RULE_KEYS.join(", ")})`);
      if (!["permit", "deny"].includes(r.action)) err(`${rp}.action`, `node "${n.name}": ${name}: action is "permit" or "deny"`);
      const proto = r.proto ?? "ip";
      if (!["ip", "icmp", "tcp", "udp"].includes(proto)) err(`${rp}.proto`, `node "${n.name}": ${name}: proto is ip, icmp, tcp or udp`);
      for (const k of ["src", "dst"]) if (r[k] !== undefined && !isAddrOrAny(r[k])) err(`${rp}.${k}`, `node "${n.name}": ${name}: ${k} is "any", an address or a prefix like 10.0.0.0/24`);
      for (const k of ["sport", "dport"]) {
        if (r[k] !== undefined && !isPortSpec(r[k])) err(`${rp}.${k}`, `node "${n.name}": ${name}: ${k} is a port number or "lo-hi"`);
        if (r[k] !== undefined && !["tcp", "udp"].includes(proto)) err(`${rp}.${k}`, `node "${n.name}": ${name}: ${k} needs proto tcp or udp`);
      }
      if (r.icmpType !== undefined && (proto !== "icmp" || !Number.isInteger(r.icmpType) || r.icmpType < 0 || r.icmpType > 255)) err(`${rp}.icmpType`, `node "${n.name}": ${name}: icmpType is a number 0-255 and needs proto icmp`);
      if (r.established !== undefined && (typeof r.established !== "boolean" || proto !== "tcp")) err(`${rp}.established`, `node "${n.name}": ${name}: established is true/false and needs proto tcp`);
    });
  }
  if (a.bind !== undefined) {
    if (!isObj(a.bind)) return err(`${p}.acl.bind`, `node "${n.name}": acl.bind maps interface names to {"in": list, "out": list}`);
    for (const [ifn, b] of Object.entries(a.bind)) {
      const bp = `${p}.acl.bind.${ifn}`;
      if (!names.includes(ifn)) err(bp, `node "${n.name}": ${ifn} is not one of its interfaces (${names.join(", ")})`);
      if (!isObj(b)) { err(bp, `node "${n.name}": ${ifn}: expected {"in": list, "out": list}`); continue; }
      for (const [d, l] of Object.entries(b)) {
        if (!["in", "out"].includes(d)) err(`${bp}.${d}`, `node "${n.name}": ${ifn}: direction is "in" or "out"`);
        else if (!(l in lists)) err(`${bp}.${d}`, `node "${n.name}": ${ifn} ${d}: no list named "${l}"`);
      }
    }
  }
}

const NAT_STATIC_KEYS = ["proto", "inside", "outside", "insidePort", "outsidePort"];
function checkNat(n, p, err) {
  const a = n.nat, names = Object.keys(isObj(n.ifaces) ? n.ifaces : {});
  if (!isObj(a)) return err(`${p}.nat`, `node "${n.name}": nat must be an object like {"inside": ["eth0"], "outside": ["eth1"], "overload": true}`);
  for (const k of Object.keys(a)) if (!["inside", "outside", "overload", "static"].includes(k)) err(`${p}.nat.${k}`, `node "${n.name}": unknown nat key "${k}" (inside, outside, overload, static)`);
  for (const side of ["inside", "outside"]) {
    if (!Array.isArray(a[side]) || !a[side].every(x => names.includes(x))) err(`${p}.nat.${side}`, `node "${n.name}": nat.${side} lists some of its interfaces (it may be empty) (${names.join(", ")})`);
  }
  if (Array.isArray(a.inside) && Array.isArray(a.outside) && a.inside.some(x => a.outside.includes(x))) err(`${p}.nat`, `node "${n.name}": an interface cannot be both inside and outside`);
  if (a.overload !== undefined && a.overload !== true && !(isObj(a.overload) && Object.keys(a.overload).every(k => k === "src") && (a.overload.src === undefined || isAddrOrAny(a.overload.src))))
    err(`${p}.nat.overload`, `node "${n.name}": overload is true or {"src": "10.1.0.0/24"}`);
  if (a.static !== undefined) {
    if (!Array.isArray(a.static)) return err(`${p}.nat.static`, `node "${n.name}": nat.static is an array of {"inside": ip, "outside": ip}`);
    a.static.forEach((s, j) => {
      const sp = `${p}.nat.static[${j}]`;
      if (!isObj(s)) return err(sp, `node "${n.name}": a static entry is an object like {"inside": "10.1.0.10", "outside": "203.0.113.10"}`);
      for (const k of Object.keys(s)) if (!NAT_STATIC_KEYS.includes(k)) err(`${sp}.${k}`, `node "${n.name}": unknown static key "${k}" (${NAT_STATIC_KEYS.join(", ")})`);
      for (const k of ["inside", "outside"]) if (!(typeof s[k] === "string" && isIp(s[k]))) err(`${sp}.${k}`, `node "${n.name}": static ${k} is an IPv4 address`);
      if (s.proto !== undefined && !["tcp", "udp"].includes(s.proto)) err(`${sp}.proto`, `node "${n.name}": static proto is tcp or udp (leave it out for 1:1)`);
      for (const k of ["insidePort", "outsidePort"]) {
        if (s[k] !== undefined && !(Number.isInteger(s[k]) && s[k] > 0 && s[k] <= 65535)) err(`${sp}.${k}`, `node "${n.name}": ${k} is a port number`);
        if (s[k] !== undefined && s.proto === undefined) err(`${sp}.${k}`, `node "${n.name}": ${k} needs proto tcp or udp`);
      }
      if ((s.insidePort === undefined) !== (s.outsidePort === undefined)) err(sp, `node "${n.name}": give both insidePort and outsidePort, or neither`);
    });
  }
}

function checkLldp(n, p, err) {
  const l = n.lldp;
  if (!isObj(l)) return err(`${p}.lldp`, `node "${n.name}": lldp must be an object like {} or {"txInterval": 30, "holdMultiplier": 4}`);
  for (const k of Object.keys(l)) if (!["txInterval", "holdMultiplier", "description"].includes(k)) err(`${p}.lldp.${k}`, `node "${n.name}": unknown lldp key "${k}" (txInterval, holdMultiplier, description)`);
  if (l.txInterval !== undefined && !(Number.isInteger(l.txInterval) && l.txInterval >= 1 && l.txInterval <= 3600)) err(`${p}.lldp.txInterval`, `node "${n.name}": txInterval is whole seconds, 1 to 3600`);
  if (l.holdMultiplier !== undefined && !(Number.isInteger(l.holdMultiplier) && l.holdMultiplier >= 1 && l.holdMultiplier <= 100)) err(`${p}.lldp.holdMultiplier`, `node "${n.name}": holdMultiplier is a whole number, 1 to 100`);
  if (l.description !== undefined && typeof l.description !== "string") err(`${p}.lldp.description`, `node "${n.name}": description is text`);
}
function checkRip(n, p, err) {
  const r = n.rip, names = Object.keys(isObj(n.ifaces) ? n.ifaces : {});
  if (!isObj(r)) return err(`${p}.rip`, `node "${n.name}": rip must be an object like {"networks": ["10.0.0.0/8"]}`);
  if (!Array.isArray(r.networks) || !r.networks.length) err(`${p}.rip.networks`, `node "${n.name}": rip needs networks: interface names or prefixes like 10.0.0.0/8`);
  else r.networks.forEach((x, j) => { if (!(isCidr(x) || names.includes(x))) err(`${p}.rip.networks[${j}]`, `node "${n.name}": "${x}" is neither one of its interfaces nor a prefix like 10.0.0.0/8`); });
  if (r.passive !== undefined && !(Array.isArray(r.passive) && r.passive.every(x => names.includes(x))))
    err(`${p}.rip.passive`, `node "${n.name}": passive must list some of its interfaces (${names.join(", ")})`);
  if (r.splitHorizon !== undefined && !["simple", "poisoned", "off"].includes(r.splitHorizon))
    err(`${p}.rip.splitHorizon`, `node "${n.name}": splitHorizon is "simple", "poisoned" or "off"`);
  if (r.timers !== undefined) {
    if (!isObj(r.timers)) err(`${p}.rip.timers`, `node "${n.name}": timers is {update, timeout, garbage, holdoff} in seconds`);
    else for (const [k, v] of Object.entries(r.timers)) {
      if (!["update", "timeout", "garbage", "holdoff"].includes(k)) err(`${p}.rip.timers.${k}`, `node "${n.name}": unknown RIP timer "${k}" (update, timeout, garbage, holdoff)`);
      else if (!(typeof v === "number" && (k === "holdoff" ? v >= 0 : v > 0))) err(`${p}.rip.timers.${k}`, `node "${n.name}": ${k} must be a number of seconds`);
    }
  }
  if (r.triggered !== undefined && typeof r.triggered !== "boolean") err(`${p}.rip.triggered`, `node "${n.name}": triggered is true or false`);
}

/** Check a spec. Returns {ok, errors: [{path, message}], warnings: [...]}; never throws. */
export function validateSpec(spec) {
  const errors = [], warnings = [];
  const err = (path, message) => errors.push({path, message});
  const warn = (path, message) => warnings.push({path, message});
  if (!isObj(spec)) { err("$", "a spec must be a JSON object"); return {ok: false, errors, warnings}; }
  if (spec.version !== undefined && spec.version !== SPEC_VERSION)
    err("$.version", `unsupported spec version ${JSON.stringify(spec.version)} (this engine reads version ${SPEC_VERSION})`);
  for (const k of Object.keys(spec)) if (!["version", "name", "about", "nodes", "links"].includes(k)) warn(`$.${k}`, `unknown top-level key "${k}" (ignored)`);
  if (!Array.isArray(spec.nodes)) err("$.nodes", "nodes must be an array");
  if (!Array.isArray(spec.links)) err("$.links", "links must be an array");

  const ifaces = new Map();   // name -> {kind, ifaces:Set}
  (Array.isArray(spec.nodes) ? spec.nodes : []).forEach((n, i) => {
    const p = `$.nodes[${i}]`;
    if (!isObj(n)) return err(p, "a node must be an object");
    if (typeof n.name !== "string" || !n.name) return err(`${p}.name`, "every node needs a name");
    if (n.name.includes(":")) err(`${p}.name`, `node name "${n.name}" may not contain ":" (links use "node:iface")`);
    const dup = ifaces.has(n.name);
    if (dup) err(`${p}.name`, `duplicate node name "${n.name}"`);
    if (!KINDS.includes(n.kind)) return err(`${p}.kind`, `node "${n.name}": kind must be one of ${KINDS.join(", ")}`);
    const names = Object.keys(isObj(n.ifaces) ? n.ifaces : {});
    // "eth0.10" is an 802.1Q subinterface of eth0: eth0 exists (and is what gets cabled) even if it has no address
    const subifs = new Set(n.kind === "switch" ? [] : names.filter(x => SUBIF_RE.test(x)));
    const parents = [...subifs].map(x => x.match(SUBIF_RE)[1]);
    if (!dup) ifaces.set(n.name, {kind: n.kind, ifaces: new Set([...names.filter(x => !subifs.has(x)), ...parents]), virtual: new Set(n.kind === "switch" ? names : subifs)});
    for (const x of subifs) {
      const vid = +x.match(SUBIF_RE)[2];
      if (!(vid >= 1 && vid <= 4094)) err(`${p}.ifaces.${x}`, `node "${n.name}": subinterface ${x}: VLAN ${vid} is not 1-4094`);
      if (x.length > 15) warn(`${p}.ifaces.${x}`, `node "${n.name}": Linux interface names are at most 15 characters ("${x}")`);
    }
    for (const x of names) if (n.kind !== "switch" && x.includes(".") && !subifs.has(x))
      err(`${p}.ifaces.${x}`, `node "${n.name}": "${x}": a name with a dot is a VLAN subinterface, written parent.vid like eth0.10`);
    for (const k of Object.keys(n)) if (![...NODE_KEYS.common, ...NODE_KEYS[n.kind]].includes(k))
      warn(`${p}.${k}`, `node "${n.name}" (${n.kind}): unknown key "${k}" (ignored)`);
    if (n.kind === "switch") {
      if (n.forwardLldp !== undefined && typeof n.forwardLldp !== "boolean") err(`${p}.forwardLldp`, `node "${n.name}": forwardLldp is true or false`);
      if (n.vlanNames !== undefined && !(isObj(n.vlanNames) && Object.entries(n.vlanNames).every(([id, v]) => /^\d+$/.test(id) && +id >= 1 && +id <= 4094 && typeof v === "string" && v)))
        err(`${p}.vlanNames`, `node "${n.name}": vlanNames must map VLAN numbers (1-4094) to non-empty names, like {"10": "sales"}`);
      if (n.blocked !== undefined && !(Array.isArray(n.blocked) && n.blocked.every(x => typeof x === "string")))
        err(`${p}.blocked`, `node "${n.name}": blocked must be a list of port names`);
      if (n.agingTime !== undefined && !(typeof n.agingTime === "number" && Number.isFinite(n.agingTime) && n.agingTime > 0))
        err(`${p}.agingTime`, `node "${n.name}": agingTime must be a number of seconds above 0 (default 300; Linux bridges treat 0 as "expire at once", which is not modeled)`);
      if (n.portSecurity !== undefined) {   // {"p1": {"max": 2, "violation": "restrict"}}; see Switch in network.js
        if (!isObj(n.portSecurity)) err(`${p}.portSecurity`, `node "${n.name}": portSecurity must be an object like {"p1": {"max": 2, "violation": "protect"}}`);
        else for (const [pn, c] of Object.entries(n.portSecurity)) {
          const q = `${p}.portSecurity.${pn}`;
          if (!(Array.isArray(spec.links) ? spec.links : []).some(l => Array.isArray(l) && l.slice(0, 2).includes(`${n.name}:${pn}`))) err(q, `node "${n.name}": portSecurity names port "${pn}", which has no cable in the spec`);
          if (!isObj(c) || !Number.isInteger(c.max) || c.max < 1) err(q, `node "${n.name}": port ${pn} needs "max": a whole number of secured addresses, 1 or more`);
          else if (c.violation !== undefined && !["protect", "restrict", "shutdown"].includes(c.violation)) err(q, `node "${n.name}": port ${pn}: violation is "protect", "restrict" or "shutdown"`);
        }
      }
      if (n.stormControl !== undefined) {   // {"p1": {"broadcast": {"rate": "100kbit", "burst": 400}}}; Police in link.js
        if (!isObj(n.stormControl)) err(`${p}.stormControl`, `node "${n.name}": stormControl must be an object like {"p1": {"broadcast": {"rate": "100kbit", "burst": 400}}}`);
        else for (const [pn, c] of Object.entries(n.stormControl)) {
          const q = `${p}.stormControl.${pn}`;
          if (!(Array.isArray(spec.links) ? spec.links : []).some(l => Array.isArray(l) && l.slice(0, 2).includes(`${n.name}:${pn}`))) err(q, `node "${n.name}": stormControl names port "${pn}", which has no cable in the spec`);
          const b = isObj(c) ? c.broadcast : undefined;
          let okRate = false; try { okRate = isObj(b) && parseRate(b.rate) > 0; } catch {}
          if (!isObj(c) || !isObj(b) || !okRate || !(Number.isFinite(b.burst) && b.burst > 0)) err(q, `node "${n.name}": port ${pn} needs "broadcast": {"rate": "100kbit", "burst": bytes} (rate like 100kbit or bits per second; burst in bytes, above 0)`);
        }
      }
      if (n.channels !== undefined) {   // port-channels (LACP): {"Po1": {"ports": ["p3", "p4"], "rate": "slow"|"fast"}}; engine/src/lacp.js
        const cabled = new Set((Array.isArray(spec.links) ? spec.links : []).flatMap(l => Array.isArray(l) ? l.slice(0, 2) : []).filter(e => typeof e === "string" && e.startsWith(n.name + ":")).map(e => e.slice(n.name.length + 1)));
        const used = new Set();
        if (!isObj(n.channels)) err(`${p}.channels`, `node "${n.name}": channels must be an object like {"Po1": {"ports": ["p3", "p4"]}}`);
        else for (const [cn, c] of Object.entries(n.channels)) {
          const q = `${p}.channels.${cn}`;
          if (!isObj(c) || !Array.isArray(c.ports) || !c.ports.length || !c.ports.every(x => typeof x === "string")) { err(q, `node "${n.name}": channel ${cn} needs "ports": a list of port names`); continue; }
          if (c.rate !== undefined && !["slow", "fast"].includes(c.rate)) err(`${q}.rate`, `node "${n.name}": channel ${cn}: rate must be "slow" (LACPDU every 30 s) or "fast" (every 1 s)`);
          for (const k of Object.keys(c)) if (!["ports", "rate"].includes(k)) warn(`${q}.${k}`, `node "${n.name}": channel ${cn}: unknown key "${k}" (ignored)`);
          if (cabled.has(cn)) err(q, `node "${n.name}": channel name "${cn}" is also a cabled port`);
          for (const x of c.ports) {
            if (!cabled.has(x)) err(`${q}.ports`, `node "${n.name}": channel ${cn}: port ${x} has no cable`);
            if (used.has(x)) err(`${q}.ports`, `node "${n.name}": port ${x} is in two channels`);
            used.add(x);
          }
        }
        if (n.stp !== undefined) err(`${p}.channels`, `node "${n.name}": spanning tree over a port-channel is not modeled yet`);
      }
      if (n.monitor !== undefined) {   // port mirroring: {"1": {"destination": "p3", "sources": {"p1": "both", "p2": "rx"}}}; Switch._setupMonitor
        const cabled = new Set((Array.isArray(spec.links) ? spec.links : []).flatMap(l => Array.isArray(l) ? l.slice(0, 2) : []).filter(e => typeof e === "string" && e.startsWith(n.name + ":")).map(e => e.slice(n.name.length + 1)));
        const chPorts = new Set(Object.values(isObj(n.channels) ? n.channels : {}).flatMap(c => isObj(c) && Array.isArray(c.ports) ? c.ports : []));
        const dests = new Set(), srcs = new Set();
        if (!isObj(n.monitor)) err(`${p}.monitor`, `node "${n.name}": monitor must be an object like {"1": {"destination": "p3", "sources": {"p1": "both"}}}`);
        else for (const [sn, s] of Object.entries(n.monitor)) {
          const q = `${p}.monitor.${sn}`;
          if (!/^\d+$/.test(sn)) err(q, `node "${n.name}": monitor session "${sn}": the session id is a number`);
          if (!isObj(s) || typeof s.destination !== "string" || !isObj(s.sources)) { err(q, `node "${n.name}": monitor session ${sn} needs "destination": a port name and "sources": {"port": "rx"|"tx"|"both"}`); continue; }
          for (const k of Object.keys(s)) if (!["destination", "sources"].includes(k)) warn(`${q}.${k}`, `node "${n.name}": monitor session ${sn}: unknown key "${k}" (ignored)`);
          if (!cabled.has(s.destination) || chPorts.has(s.destination)) err(`${q}.destination`, `node "${n.name}": monitor session ${sn}: destination ${s.destination} must be a cabled port that is not in a channel`);
          if (dests.has(s.destination)) err(`${q}.destination`, `node "${n.name}": port ${s.destination} is the destination of two monitor sessions`);
          dests.add(s.destination);
          for (const [port, dir] of Object.entries(s.sources)) {
            if (!cabled.has(port) || chPorts.has(port)) err(`${q}.sources.${port}`, `node "${n.name}": monitor session ${sn}: source ${port} must be a cabled port that is not in a channel`);
            if (!["rx", "tx", "both"].includes(dir)) err(`${q}.sources.${port}`, `node "${n.name}": monitor session ${sn}: direction of ${port} is "rx", "tx" or "both"`);
            if (port === s.destination) err(`${q}.sources.${port}`, `node "${n.name}": monitor session ${sn}: ${port} is both source and destination`);
            srcs.add(port);
          }
        }
        for (const d of dests) if (srcs.has(d)) err(`${p}.monitor`, `node "${n.name}": port ${d} cannot be a monitor destination and a monitor source`);
        if (n.stp !== undefined) err(`${p}.monitor`, `node "${n.name}": port mirroring together with spanning tree is not modeled yet`);
      }
      if (n.ifaces === undefined) {
        for (const k of ["routes", "gw"]) if (n[k] !== undefined) err(`${p}.${k}`, `node "${n.name}": a switch needs SVIs ("ifaces": {"vlan10": ...}) before it can have ${k}`);
        return;
      }
      // Layer 3 switch: every interface is an SVI named vlanN for a VLAN the switch carries
      const carried = new Set(); for (const c of Object.values(isObj(n.vlans) ? n.vlans : {})) if (isObj(c))
        for (const v of [c.access, ...(Array.isArray(c.trunk) ? c.trunk : []), c.native]) if (v !== undefined && v !== null) carried.add(v);
      for (const x of names) {
        const m = x.match(/^vlan(\d+)$/);
        if (!m) { err(`${p}.ifaces.${x}`, `node "${n.name}": a switch's interfaces are SVIs named vlanN (like vlan10), not "${x}"`); continue; }
        if (!(+m[1] >= 1 && +m[1] <= 4094)) err(`${p}.ifaces.${x}`, `node "${n.name}": ${x}: VLAN ${m[1]} is not 1-4094`);
        else if (!isObj(n.vlans)) err(`${p}.ifaces.${x}`, `node "${n.name}": SVIs need a VLAN-aware switch (add "vlans")`);
        else if (!carried.has(+m[1])) warn(`${p}.ifaces.${x}`, `node "${n.name}": no port carries VLAN ${m[1]}, so ${x} can't reach anyone`);
        if (n.ifaces[x] === "dhcp") err(`${p}.ifaces.${x}`, `node "${n.name}": SVIs need a fixed address`);
      }
    }
    if (n.ifaces !== undefined && !isObj(n.ifaces)) err(`${p}.ifaces`, `node "${n.name}": ifaces must map interface name to "a.b.c.d/len"`);
    const nets = [];
    for (const [ifn, cidr] of Object.entries(isObj(n.ifaces) ? n.ifaces : {})) {
      if (ambiguousIfname(ifn)) warn(`${p}.ifaces.${ifn}`, `node "${n.name}": interface name "${ifn}" reads as \`ip link\` keyword "${ambiguousIfname(ifn)}": the Linux validators can't build it (use e.g. eth0)`);
      if (cidr === "dhcp") continue;
      if (!isCidr(cidr)) { err(`${p}.ifaces.${ifn}`, `node "${n.name}": "${cidr}" is not an address like 10.0.0.1/24`); continue; }
      nets.push(parseCidr(cidr));
    }
    const reachable = via => nets.some(c => inSubnet(via, c.net, c.mask));
    if (n.gw !== undefined && n.gw !== null) {
      if (!isIp(n.gw)) err(`${p}.gw`, `node "${n.name}": gateway "${n.gw}" is not an IPv4 address`);
      else if (nets.length && !reachable(n.gw)) err(`${p}.gw`, `node "${n.name}": gateway ${n.gw} is not on any of its subnets`);
    }
    if (n.routes !== undefined) {
      if (!Array.isArray(n.routes)) err(`${p}.routes`, `node "${n.name}": routes must be a list of ["dst/len", "via"]`);
      else n.routes.forEach((r, j) => {
        const rp = `${p}.routes[${j}]`;
        if (!Array.isArray(r) || r.length !== 2) return err(rp, `node "${n.name}": a route is ["dst/len", "via"]`);
        if (!isCidr(r[0])) err(rp, `node "${n.name}": route destination "${r[0]}" is not like 10.1.0.0/24`);
        if (!isIp(r[1])) err(rp, `node "${n.name}": route next hop "${r[1]}" is not an IPv4 address`);
        else if (nets.length && !reachable(r[1])) err(rp, `node "${n.name}": next hop ${r[1]} is not on any of its subnets`);
      });
    }
    if (n.ospf !== undefined) checkOspf(n, p, err);
    if (n.rip !== undefined) checkRip(n, p, err);
    if (n.lldp !== undefined) checkLldp(n, p, err);
    if (n.acl !== undefined) checkAcl(n, p, err);
    if (n.nat !== undefined) checkNat(n, p, err);
    if (n.services !== undefined) {
      if (!isObj(n.services)) err(`${p}.services`, `node "${n.name}": services must be an object`);
      else if (n.services.dns !== undefined && !(isObj(n.services.dns) && Object.values(n.services.dns).every(isIp)))
        err(`${p}.services.dns`, `node "${n.name}": dns must map names to IPv4 addresses`);
      if (isObj(n.services) && n.services.syslog !== undefined && typeof n.services.syslog !== "boolean") err(`${p}.services.syslog`, `node "${n.name}": syslog is true or false`);
      if (isObj(n.services) && n.services.dhcp !== undefined) {
        const d = n.services.dhcp;
        if (!isObj(d) || !Array.isArray(d.range) || d.range.length !== 2 || !d.range.every(isIp)) err(`${p}.services.dhcp`, `node "${n.name}": dhcp needs range: ["first", "last"]`);
        else if (nets.length && !reachable(d.range[0])) err(`${p}.services.dhcp.range`, `node "${n.name}": DHCP range is on none of its subnets`);
      }
      if (isObj(n.services) && n.services.dhcpRelay !== undefined) {
        const r = n.services.dhcpRelay;
        if (!isObj(r) || !isIp(r.server)) err(`${p}.services.dhcpRelay`, `node "${n.name}": dhcpRelay needs server: "a.b.c.d"`);
        else if (r.clients !== undefined && !(Array.isArray(r.clients) && r.clients.every(c => isObj(n.ifaces) && c in n.ifaces)))
          err(`${p}.services.dhcpRelay.clients`, `node "${n.name}": clients must list its own interfaces`);
      }
    }
  });

  const cabled = new Set();
  (Array.isArray(spec.links) ? spec.links : []).forEach((l, i) => {
    const p = `$.links[${i}]`;
    if (!Array.isArray(l) || l.length < 2 || l.length > 4) return err(p, `a link is ["node:iface", "node:iface", delayMs?, {shape?, shapeBack?}?]`);
    if (l.length >= 3 && !(typeof l[2] === "number" && l[2] >= 0)) err(`${p}[2]`, "delay must be a number of milliseconds ≥ 0");
    if (l.length === 4) {
      if (!isObj(l[3])) err(`${p}[3]`, "link options must be an object");
      else for (const [k, v] of Object.entries(l[3])) {
        if (!["shape", "shapeBack"].includes(k)) { warn(`${p}[3].${k}`, `unknown link option "${k}" (ignored)`); continue; }
        if (!isObj(v)) { err(`${p}[3].${k}`, `${k} is {rate, burst, limit}`); continue; }
        try { parseRate(v.rate); } catch (e) { err(`${p}[3].${k}.rate`, e.message); }
        for (const b of ["burst", "limit"]) if (!(Number.isInteger(v[b]) && v[b] > 0)) err(`${p}[3].${k}.${b}`, `${b} must be a positive number of bytes`);
      }
    }
    for (const ref of l.slice(0, 2)) {
      if (typeof ref !== "string" || ref.split(":").length !== 2) { err(p, `"${ref}" is not "node:iface"`); continue; }
      const [node, ifn] = ref.split(":"); const n = ifaces.get(node);
      if (!n) { err(p, `no node named "${node}"`); continue; }
      if (n.virtual.has(ifn)) { err(p, `${node}:${ifn} is a virtual interface (${n.kind === "switch" ? "an SVI" : "a VLAN subinterface"}); cable ${n.kind === "switch" ? "a switch port" : ifn.match(SUBIF_RE)[1]} instead`); continue; }
      if (n.kind !== "switch" && !n.ifaces.has(ifn)) err(p, `${node} has no interface "${ifn}" (it has ${[...n.ifaces].join(", ") || "none"})`);
      if (n.kind === "switch" && ambiguousIfname(ifn)) warn(p, `${node}: port name "${ifn}" reads as \`ip link\` keyword "${ambiguousIfname(ifn)}": the Linux validators can't build it (use e.g. p1)`);
      if (cabled.has(ref)) err(p, `${ref} is cabled twice`);
      cabled.add(ref);
    }
  });
  return {ok: !errors.length, errors, warnings};
}

/** Actions: each entry runs on a cold network (caches flushed). Features register theirs here. */
export const ACTIONS = {
  ping: {required: ["src", "dst"], run: (net, a) => ping(net, a.src, a.dst, {ttl: a.ttl ?? 64, timeout: a.timeout ?? 2})},
  traceroute: {required: ["src", "dst"], run: (net, a) => traceroute(net, a.src, a.dst, {maxHops: a.maxHops ?? 8})},
  dns: {required: ["src", "server", "name"], run: (net, a) => dns(net, a.src, a.server, a.name)},
  dhcp: {required: ["src"], run: (net, a) => dhcp(net, a.src, {iface: a.iface, tries: a.tries ?? 3, interval: a.interval ?? 1})},
  tcp: {required: ["src", "dst", "port"], run: (net, a) => tcpAction(net, a)},
  // Pause `seconds` of simulated time (MAC entries age; use "keepCaches": true on the actions around it).
  wait: {required: ["seconds"], run: (net, a) => { const until = net.time + a.seconds; net.run(until); if (net.time < until) net.time = until; return {waited: a.seconds, time: net.time}; }},   // the clock advances even when no event is due (RIP timers)
  // The spanning-tree state of a switch right now (root, port roles and states, topology-change flag).
  stp: {required: ["switch"], run: (net, a) => {
    const n = net.nodes.get(a.switch); if (!n || n.kind !== "switch" || !n.stp) throw new Error(`${a.switch} is not a switch running spanning tree`);
    return {switch: a.switch, ...n.stp.describe()};
  }},
  // The MAC address table of a switch right now: [{vlan, mac, port, age}]
  macTable: {required: ["switch"], run: (net, a) => {
    const n = net.nodes.get(a.switch); if (!n || n.kind !== "switch") throw new Error(`no switch named ${a.switch}`);
    return {switch: a.switch, entries: n.macTable()};
  }},
  // Port security on a switch right now: [{port, max, violation, secured, violations, errdisabled}]
  portSecurity: {required: ["switch"], run: (net, a) => {
    const n = net.nodes.get(a.switch); if (!n || n.kind !== "switch") throw new Error(`no switch named ${a.switch}`);
    return {switch: a.switch, ports: n.portSecurity()};
  }},
  // Storm control on a switch right now: [{port, broadcast: {rate, burst, passed, dropped}}]
  stormControl: {required: ["switch"], run: (net, a) => {
    const n = net.nodes.get(a.switch); if (!n || n.kind !== "switch") throw new Error(`no switch named ${a.switch}`);
    return {switch: a.switch, ports: n.stormControl()};
  }},
  // The port-channels of a switch right now: each channel's members with their LACP state bytes and whether they carry traffic.
  lacp: {required: ["switch"], run: (net, a) => {
    const n = net.nodes.get(a.switch); if (!n || n.kind !== "switch") throw new Error(`no switch named ${a.switch}`);
    return {switch: a.switch, channels: [...n.channels.values()].map(c => c.describe())};
  }},
  syslog: {required: ["src", "dst", "message"], run: (net, a) => syslogSend(net, a.src, a.dst, {message: a.message, tag: a.tag, facility: a.facility, severity: a.severity, settle: a.settle})},
  udp: {required: ["src", "dst", "port"], run: (net, a) => udpRequest(net, a.src, a.dst, a.port, {probe: true})},
  // `count` UDP datagrams of `size` payload bytes, back to back, no answer expected (load for link shaping)
  udpBurst: {required: ["src", "dst", "port", "count", "size"], run: (net, a) => {
    const n = stackOf(net, a.src); const sport = n.nextPort++; let sent = 0;
    for (let k = 0; k < a.count; k++) if (n.sendIp({dst: a.dst, ttl: 64, proto: "udp", udp: {sport, dport: a.port, payload: null, size: a.size}})) sent++;
    return {sent};
  }},
};
// Time and cables, for protocols that need them (RIP): advance the clock; cut or restore a cable (both ends lose
// carrier); read a router's RIP table.
ACTIONS.link = {required: ["end", "up"], run: (net, a) => { net.setLink(a.end, !!a.up); return {end: a.end, up: !!a.up}; }};
// A node's LLDP neighbor table: {t, neighbors: [{iface, chassisId, portId, portDescr, sysName, sysDescr, caps, ttl}]}
ACTIONS.lldpNeighbors = {required: ["src"], run: (net, a) => { const n = net.node(a.src); return {t: net.time, neighbors: n.lldp ? n.lldp.neighbors() : []}; }};
ACTIONS.ripTable = {required: ["src"], run: (net, a) => { const n = net.node(a.src); return {t: net.time, routes: n.rip ? n.rip.describe() : []}; }};
// One network across every RIP router: {t, routers: {R1: {metric, nextHop, type} | null}}
ACTIONS.ripRoute = {required: ["network"], run: (net, a) => {
  const routers = {};
  for (const n of net.nodes.values()) if (n.rip) { const r = n.rip.describe().find(x => x.network === a.network); routers[n.name] = r ? {metric: r.metric, nextHop: r.nextHop, type: r.type} : null; }
  return {t: net.time, routers};
}};
export function registerAction(name, def) { ACTIONS[name] = def; }

export function validateActions(actions, spec = null) {
  const errors = [];
  const names = new Set(spec && Array.isArray(spec.nodes) ? spec.nodes.map(n => n && n.name) : []);
  if (!Array.isArray(actions)) return {ok: false, errors: [{path: "$", message: "actions must be a JSON array"}], warnings: []};
  actions.forEach((a, i) => {
    const p = `$[${i}]`;
    if (!isObj(a)) return errors.push({path: p, message: "an action must be an object"});
    const def = ACTIONS[a.do];
    if (!def) return errors.push({path: `${p}.do`, message: `unknown action "${a.do}" (known: ${Object.keys(ACTIONS).join(", ")})`});
    for (const k of def.required) if (a[k] === undefined) errors.push({path: `${p}.${k}`, message: `${a.do} needs "${k}"`});
    if (spec && a.src !== undefined && !names.has(a.src)) errors.push({path: `${p}.src`, message: `no node named "${a.src}"`});
    const sn = spec && Array.isArray(spec.nodes) && spec.nodes.find(n => n && n.name === a.src);
    if (sn && sn.kind === "switch" && !isObj(sn.ifaces)) errors.push({path: `${p}.src`, message: `${a.src} is a switch with no IP interfaces (give it SVIs: "ifaces": {"vlan10": ...})`});
    if (a.do === "wait" && !(typeof a.seconds === "number" && a.seconds >= 0)) errors.push({path: `${p}.seconds`, message: "seconds must be a number ≥ 0"});
    if (a.switch !== undefined && !(spec && Array.isArray(spec.nodes) ? spec.nodes.some(n => n && n.name === a.switch && n.kind === "switch") : typeof a.switch === "string")) errors.push({path: `${p}.switch`, message: `no switch named "${a.switch}"`});
    if (a.keepCaches !== undefined && typeof a.keepCaches !== "boolean") errors.push({path: `${p}.keepCaches`, message: "keepCaches must be true or false"});
    if (a.settle !== undefined && !(typeof a.settle === "number" && a.settle >= 0)) errors.push({path: `${p}.settle`, message: "settle must be seconds ≥ 0"});
  });
  return {ok: !errors.length, errors, warnings: []};
}

export class SpecError extends Error {
  constructor(what, errors) { super(`${what} is not valid:\n` + errors.map(e => `  ${e.path}: ${e.message}`).join("\n")); this.errors = errors; }
}

/** Validate, then build. Throws SpecError listing every problem. */
export function loadSpec(spec) {
  const v = validateSpec(spec);
  if (!v.ok) throw new SpecError("spec", v.errors);
  return Network.fromSpec(spec);
}

/**
 * Run actions on a spec. Caches (ARP, MAC tables) are flushed before every action unless it says "keepCaches": true, so each starts cold
 * and its frame counts don't depend on the order. Returns one entry per action:
 * {action, result, frames: {"A:if>B:if": n}, trace?: [{t, node, event, detail}]}.
 */
export function runActions(spec, actions, {trace = false} = {}) {
  const net = loadSpec(spec);
  const va = validateActions(actions, spec);
  if (!va.ok) throw new SpecError("actions", va.errors);
  const out = [];
  // Port mirroring: the frames that leave each monitor port, in order, as "A:eth0>B:eth0 icmp 8" (validate/span compares them with tcpdump).
  const monPorts = new Set([...net.nodes.values()].flatMap(n => n.mirrorDest ? [...n.mirrorDest].map(p => `${n.name}:${p}`) : []));
  let mirrored = {};
  if (monPorts.size) {
    const macName = new Map([...net.nodes.values()].flatMap(n => Object.values(n.ifaces).filter(i => i.mac).map(i => [i.mac.toLowerCase(), `${n.name}:${i.name}`])));
    const nm = m => macName.get(m.toLowerCase()) ?? m.toLowerCase();
    net.taps.add((node, ifname, f) => {
      if (!monPorts.has(`${node.name}:${ifname}`)) return;
      const what = f.type === "arp" ? `arp ${f.arp.op}` : f.type === "ipv4" ? `${f.ip.proto}${f.ip.icmp ? " " + f.ip.icmp.type : ""}` : f.type;
      const peer = node.ifaces[ifname].peer;
      (mirrored[`${node.name}:${ifname}>${peer.node.name}:${peer.name}`] ||= []).push(`${nm(f.src)}>${nm(f.dst)} ${what}`);
    });
  }
  for (const a of actions) {
    mirrored = {};
    if (!a.keepCaches) net.flushCaches();   // keepCaches: carry ARP caches and MAC tables over from the last action
    const before = net.snapshot(); const t0 = net.trace.length; const qBefore = queueStats(net);
    const result = ACTIONS[a.do].run(net, a);
    net.settle(a.settle ?? (["wait", "macTable", "stp", "lacp"].includes(a.do) ? 0 : 1));
    const entry = {action: a, result, frames: net.diff(before)};
    if (monPorts.size) entry.mirrored = mirrored;
    const q = queueStats(net);
    if (Object.keys(q).length) { entry.drops = {}; for (const [k, v] of Object.entries(q)) { const d = v.dropped - (qBefore[k]?.dropped ?? 0); if (d) entry.drops[k] = d; } }
    const nats = [...net.nodes.values()].filter(n => n.nat);
    if (nats.length) entry.nat = Object.fromEntries(nats.map(n => [n.name, n.nat.conntrack()]));   // live tracking entries, in conntrack's shape (validate/nat compares them)
    if (trace) entry.trace = net.trace.slice(t0);
    out.push(entry);
  }
  return out;
}
