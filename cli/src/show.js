// Show handlers. Each returns {text, json}: `| json` prints json, so every show command has a JSON form by
// construction. ctx: {model, kind, ports, device, backend, state()}.

import * as M from "./model.js";
import {runningConfig, ruleText} from "./render.js";
import {formatVlanList} from "./types.js";

const pad = (s, n) => String(s ?? "").padEnd(n);
const table = (head, rows) => {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i] ?? "").length)) + 2);
  return [head.map((h, i) => pad(h, w[i])).join("").trimEnd(), ...rows.map(r => r.map((c, i) => pad(c, w[i])).join("").trimEnd())].join("\n");
};

export const SHOWS = {
  "show.running-config": ctx => ({text: runningConfig(ctx.model, {kind: ctx.kind, ports: ctx.ports()}), json: ctx.model}),
  "show.running-config-openconfig": ctx => ({text: JSON.stringify(M.toOpenConfig(ctx.model), null, 2), json: M.toOpenConfig(ctx.model)}),

  "show.version": ctx => {
    const json = {software: "OpenPacketRouter CLI", license: "Apache-2.0", backend: ctx.backend.name, hostname: ctx.device, kind: ctx.kind};
    return {json, text: `OpenPacketRouter CLI (Apache-2.0)\nDevice ${ctx.device}, a ${ctx.kind}, running on the ${ctx.backend.name} backend`};
  },

  "show.dhcp-snooping": ctx => {
    const s = ctx.state().dhcpSnooping;
    if (!s) return {json: {enabled: false}, text: "DHCP snooping is off (ip dhcp snooping)."};
    return {json: {enabled: true, trusted: s.trusted, dropped: s.dropped}, text: ["DHCP snooping is on.", "Trusted ports: " + (s.trusted.join(", ") || "none"), "Server messages dropped on untrusted ports: " + (Object.entries(s.dropped).map(([p, c]) => `${p} ${c}`).join(", ") || "none")].join("\n")};
  },
  "show.lldp": ctx => {
    const cfg = M.services(ctx.model).lldp, live = ctx.state().lldp;
    if (!cfg) return {json: {enabled: false}, text: "LLDP is not running (use \"lldp run\" in configuration mode)"};
    const json = {enabled: true, txInterval: cfg.txInterval ?? 30, holdMultiplier: cfg.holdMultiplier ?? 4,
      ttl: (cfg.txInterval ?? 30) * (cfg.holdMultiplier ?? 4), ...(cfg.description !== undefined ? {description: cfg.description} : {}),
      ...(live ? {neighbors: live.neighbors.length} : {})};
    return {json, text: [`LLDP is running: advertisement every ${json.txInterval} s, hold multiplier ${json.holdMultiplier} (neighbors keep us ${json.ttl} s)`,
      ...(live ? [`${live.neighbors.length} neighbor${live.neighbors.length === 1 ? "" : "s"} heard`] : [])].join("\n")};
  },
  "show.lldp-neighbors": ctx => {
    if (!M.services(ctx.model).lldp) return {json: [], text: "LLDP is not running (use \"lldp run\" in configuration mode)"};
    const rows = ctx.state().lldp?.neighbors || [];
    return {json: rows, text: rows.length ? table(["Interface", "Neighbor", "Neighbor port", "Port description", "Capabilities", "TTL"],
      rows.map(r => [r.iface, r.sysName, r.portId, r.portDescr, (r.caps || []).join(","), r.ttl])) : "No neighbors heard"};
  },

  "show.interface-brief": ctx => {
    const st = ctx.state().interfaces || [];
    const rows = ctx.ports().map(p => {
      const ifc = M.iface(ctx.model, p, false), live = st.find(x => x.name === p) || {};
      const cfg = ifc ? M.addressesOf(ifc)[0] : null;
      const method = ifc && M.dhcpClientOf(ifc) ? "dhcp" : cfg ? "manual" : "none";
      const address = live.address || (cfg ? `${cfg.ip}/${cfg.prefixLength}` : null);
      const admin = ifc && ifc.config.enabled === false ? "down" : "up";
      return {name: p, address, method, admin, link: live.status ? (live.status === "up" ? "up" : "down") : "unknown"};
    });
    return {json: rows, text: table(["Interface", "Address", "Method", "Admin", "Link"], rows.map(r => [r.name, r.address || "-", r.method, r.admin, r.link]))};
  },

  "show.ip-route": ctx => {
    const rows = ctx.state().routes || [];
    const code = r => r.protocol === "connected" ? "C" : r.protocol === "ospf" ? "O" : r.protocol === "rip" ? "R" : r.protocol === "bgp" ? "B" : "S";
    const legend = [rows.some(r => r.protocol === "ospf") && ", O = learned through OSPF", rows.some(r => r.protocol === "rip") && ", R = learned by RIP", rows.some(r => r.protocol === "bgp") && ", B = learned through BGP"].filter(Boolean).join("");
    const lines = [`Legend: C = connected network, S = static route${legend}`, ""];
    for (const r of rows) lines.push(r.protocol === "connected"
      ? `C  ${r.prefix} on ${r.interface} (directly connected)`
      : `${code(r)}  ${r.prefix} via ${r.nextHop}${r.protocol === "ospf" && r.metric !== undefined ? ` (cost ${r.metric})` : ""}${r.interface ? `, out ${r.interface}` : ", next hop not on any connected network"}${r.protocol === "rip" ? ` [metric ${r.metric}]` : ""}`);
    if (!rows.length) lines.push("(no routes)");
    return {json: rows, text: lines.join("\n")};
  },

  "show.ip-rip": ctx => {
    const rows = ctx.state().rip;
    if (!rows) return {json: [], text: "RIP is not running on this device"};
    return {json: rows, text: rows.length ? table(["Code", "Network", "Next hop", "Metric", "Interface"], rows.map(r => [r.type, r.network, r.type === "C" ? "-" : r.nextHop, r.metric, r.iface ?? "-"])) : "The RIP table is empty"};
  },

  "show.ip-bgp": ctx => {
    const b = ctx.state().bgp;
    if (!b) return {json: [], text: "BGP is not running on this device"};
    const rows = b.routes.map(r => ({prefix: r.prefix, status: r.best ? "best" : r.valid ? "valid" : "invalid", from: r.from, nextHop: r.nextHop, localPref: r.localPref, asPath: r.asPath, origin: r.origin}));
    const mark = r => (r.status === "invalid" ? " " : "*") + (r.status === "best" ? ">" : " ");
    return {json: rows, text: rows.length ? "Status: * valid, > best path\n" + table(["", "Network", "Next hop", "Local pref", "Path"], rows.map(r => [mark(r), r.prefix, r.nextHop, r.localPref, `${r.asPath ? r.asPath + " " : ""}${r.origin === "igp" ? "i" : r.origin === "egp" ? "e" : "?"}`]))
      : "The BGP table is empty"};
  },

  "show.ip-bgp-summary": ctx => {
    const b = ctx.state().bgp;
    if (!b) return {json: null, text: "BGP is not running on this device"};
    const rows = b.neighbors.map(n => ({neighbor: n.ip, remoteAs: n.remoteAs, state: n.state, routerId: n.routerId, prefixesReceived: n.received}));
    return {json: {routerId: b.routerId, asn: b.asn, neighbors: rows}, text: `BGP router identifier ${b.routerId}, local AS number ${b.asn}\n` + table(["Neighbor", "AS", "State", "Router ID", "Prefixes received"], rows.map(n => [n.neighbor, n.remoteAs, n.state, n.routerId ?? "-", n.prefixesReceived]))};
  },

  "show.arp": ctx => {
    const rows = ctx.state().arp || [];
    return {json: rows, text: rows.length ? table(["Address", "MAC", "Interface"], rows.map(r => [r.ip, r.mac, r.interface]))
      : "ARP table is empty (it fills when this device sends or answers traffic: try ping)"};
  },

  "show.mac-table": ctx => {
    const rows = ctx.state().mac || [];
    return {json: rows, text: rows.length ? table(["VLAN", "MAC", "Port", "Age (s)"], rows.map(r => [r.vlan, r.mac, r.port, r.age === undefined ? "-" : +r.age.toFixed(1)])) + `\n${rows.length} entries`
      : "MAC table is empty (it fills as frames arrive: try a ping between two hosts)"};
  },

  "show.mac-aging": ctx => {
    const configured = M.fdb(ctx.model)["mac-aging-time"], seconds = configured ?? 300;
    return {json: {seconds, default: configured === undefined}, text: `MAC address aging time: ${seconds} seconds${configured === undefined ? " (default)" : ""}`};
  },

  "show.port-security": ctx => {
    const rows = ctx.state().portSecurity || [];
    return {json: rows, text: rows.length ? table(["Port", "Max", "Secured", "Violation", "Violations", "State"], rows.map(r => [r.port, r.max, r.secured.length, r.violation, r.violations, r.errdisabled ? "err-disabled" : "secure-up"])) : "Port security is not on for any port (switchport port-security maximum N, on an access port)"};  },

  "show.storm-control": ctx => {
    const rows = ctx.state().stormControl || [];
    return {json: rows, text: rows.length ? table(["Port", "Type", "Rate", "Burst (bytes)", "Passed", "Dropped"], rows.filter(r => r.broadcast).map(r => [r.port, "broadcast", r.broadcast.rate, r.broadcast.burst, r.broadcast.passed, r.broadcast.dropped])) : "Storm control is not on for any port (storm-control broadcast rate RATE burst BYTES, on a switch port)"};
  },

  "show.monitor": ctx => {
    const all = Object.entries(ctx.model.monitor || {});
    if (!all.length) return {json: {}, text: "No monitor sessions (monitor session 1 destination interface p3, monitor session 1 source interface p1 creates one)"};
    const rows = all.map(([n, s]) => [n, s.destination || "(none)", Object.entries(s.sources).map(([p, d]) => `${p}(${d})`).join(" ") || "(none)"]);
    return {json: ctx.model.monitor, text: table(["Session", "Destination", "Sources"], rows)};
  },
  "show.etherchannel": ctx => {
    const ch = ctx.state().lacp || [];
    if (!ch.length) return {json: [], text: "No port-channels on this switch (channel-group N mode active on two or more ports makes one)"};
    // flags: P = bundled (collecting and distributing), w = waiting to be bundled, D = down
    const flag = m => !m.up ? "D" : m.aggregated ? "P" : "w";
    const rows = ch.map(c => [c.name, "LACP", c.rate, c.members.map(m => `${m.port}(${flag(m)})`).join(" ")]);
    return {json: ch, text: "Flags: P bundled, w waiting, D down\n" + table(["Channel", "Protocol", "Rate", "Ports"], rows)};
  },

  "show.spanning-tree": ctx => {
    const d = ctx.state().stp;
    if (!d) return {json: null, text: "Spanning tree is off on this switch"};
    const g = M.stpGlobal(ctx.model);
    const timers = {helloTime: g["hello-time"] ?? 2, maxAge: g["max-age"] ?? 20, forwardDelay: g["forwarding-delay"] ?? 15, priority: g["bridge-priority"] ?? 32768};
    const rstp = d.mode === "rstp";
    const lines = [`Protocol ${rstp ? "rapid spanning tree (RSTP)" : "spanning tree (STP)"}`, `Bridge ${d.bridgeId}${d.isRoot ? "  (this switch is the root)" : ""}`, `Root   ${d.root}`];
    if (!d.isRoot) lines.push(`Path cost to root ${d.rootCost}, through port ${d.rootPort}`);
    lines.push(`Topology change: ${d.topologyChange ? "in progress" : "none"}${d.topologyChangeDetected ? " (detected by this switch)" : ""}`);
    lines.push(`Priority ${timers.priority}, hello ${timers.helloTime} s, max age ${timers.maxAge} s, forward delay ${timers.forwardDelay} s`);
    lines.push("", table(["Port", "Role", "State", "Cost", "Port ID", ...(rstp ? ["Edge"] : [])], Object.entries(d.ports).map(([p, x]) => [p, x.role, x.state, x.cost, `${x.id >> 8}.${x.no}`, ...(rstp ? [x.edge ? "yes" : "no"] : [])])));
    return {json: {...d, mode: d.mode ?? "stp", timers}, text: lines.join("\n")};
  },

  "show.spanning-tree-interface": (ctx, [name]) => {
    const d = ctx.state().stp;
    if (!d) return {json: null, text: "Spanning tree is off on this switch"};
    const x = d.ports[name];
    if (!x) return {json: null, text: `% ${name} is not a spanning-tree port on ${ctx.device} (it has ${Object.keys(d.ports).join(", ")})`};
    const text = [`Port ${name}: ${x.role}, ${x.state}`, `  Port ID ${x.id >> 8}.${x.no}, path cost ${x.cost}`,
      `  Designated root ${x.designatedRoot}, cost ${x.designatedCost}`, `  Designated bridge ${x.designatedBridge}, port ${x.designatedPort >> 8}.${x.designatedPort & 255}`].join("\n");
    return {json: {name, ...x}, text};
  },

  // One VLAN: its access ports, the trunks that carry it, and its SVI if the switch routes.
  "show.vlan-id": (ctx, [vid]) => {
    const access = [], trunks = [];
    for (const p of ctx.ports()) {
      if (/^vlan\d+$/.test(p)) continue;
      const ifc = M.iface(ctx.model, p, false), sv = ifc && M.switchedVlan(ifc, false);
      if (sv && sv["interface-mode"] === "TRUNK") { if (sv["trunk-vlans"].includes(vid)) trunks.push({port: p, native: (sv["native-vlan"] ?? 1) === vid}); }
      else if ((sv && sv["access-vlan"] || 1) === vid) access.push(p);
    }
    const svi = (ctx.state().interfaces || []).find(i => i.name === `vlan${vid}`);
    const name = M.vlans(ctx.model)[vid]?.config?.name || (vid === 1 ? "default" : `VLAN${String(vid).padStart(4, "0")}`);
    const json = {vlan: vid, name, accessPorts: access, trunkPorts: trunks, ...(svi ? {svi: svi.name, address: svi.address ?? null, link: svi.status} : {})};
    if (!access.length && !trunks.length && !svi) return {json, text: `VLAN ${vid} has no ports on ${ctx.device}`};
    const text = [`VLAN ${vid} (${name})`, `  Access ports: ${access.join(", ") || "none"}`,
      `  Trunk ports:  ${trunks.map(x => x.port + (x.native ? " (native)" : "")).join(", ") || "none"}`,
      ...(svi ? [`  SVI ${svi.name}: ${svi.address || "no address"}, ${svi.status}`] : [])].join("\n");
    return {json, text};
  },

  // Access lists: each rule numbered as `no rule N` counts them, and where the list is applied.
  "show.access-lists": (ctx, values) => {
    const acl = M.services(ctx.model).acl, only = values && values[0];
    if (only && !(acl && acl.lists[only])) return {json: {accessLists: []}, text: `No access list named ${only}`};
    const applied = {};
    for (const [ifn, ifc] of Object.entries(M.interfaces(ctx.model))) for (const d of ["in", "out"]) {
      const n = ifc["openpacketrouter:acl"]?.[d]; if (n) (applied[n] ||= []).push({interface: ifn, direction: d});
    }
    const lists = Object.entries(acl ? acl.lists : {}).filter(([n]) => !only || n === only).map(([name, rules]) => ({
      name, applied: applied[name] || [], rules: rules.map((r, i) => ({number: i + 1, ...r, text: ruleText(r)})), implicitDeny: true}));
    const text = lists.length ? lists.map(l => [`Access list ${l.name}${l.applied.length ? ` (applied ${l.applied.map(a => `${a.direction} on ${a.interface}`).join(", ")})` : " (not applied)"}`,
      ...l.rules.map(r => `  ${r.number}  ${r.text}`), "  (implicit deny: anything else is dropped)"].join("\n")).join("\n\n") : "No access lists";
    return {json: {accessLists: lists}, text};
  },

  // NAT: the fixed mappings and every tracked flow (engine state), and a summary.
  "show.nat-translations": ctx => {
    const rows = (ctx.state().nat || {}).translations || [];
    const json = {translations: rows};
    if (!rows.length) return {json, text: "No translations"};
    const text = table(["Proto", "Inside global", "Inside local", "Outside local", "Outside global", "Expires in"],
      rows.map(r => [r.proto, r.insideGlobal, r.insideLocal, r.outsideLocal, r.outsideGlobal, r.static ? "never" : `${r.secondsLeft}s`]));
    return {json, text};
  },
  "show.nat-statistics": ctx => {
    const nat = M.services(ctx.model).nat, ifs = M.interfaces(ctx.model), st = ctx.state().nat || {};
    const side = s => Object.entries(ifs).filter(([, i]) => i["openpacketrouter:nat"] === s).map(([n]) => n);
    const json = {inside: side("inside"), outside: side("outside"), overload: nat?.overload ? (nat.overload === true ? "any" : nat.overload.src) : null,
      static: (nat?.static || []).length, translations: (st.translations || []).filter(r => !r.static).length, hits: st.hits ?? 0, misses: st.misses ?? 0};
    const text = [`Inside interfaces:  ${json.inside.join(", ") || "none"}`, `Outside interfaces: ${json.outside.join(", ") || "none"}`,
      `Overload: ${json.overload ?? "off"}   Fixed mappings: ${json.static}`,
      `Flows being translated: ${json.translations}   Table hits: ${json.hits}   Misses: ${json.misses}`].join("\n");
    return {json, text};
  },

  "show.vlan-brief": ctx => {
    const by = new Map(), trunks = [];
    const svis = [];
    for (const p of ctx.ports()) {
      if (/^vlan\d+$/.test(p)) { svis.push(p); continue; }       // an SVI is a Layer 3 interface, not a switch port
      const ifc = M.iface(ctx.model, p, false), sv = ifc && M.switchedVlan(ifc, false);
      if (sv && sv["interface-mode"] === "TRUNK") { trunks.push({port: p, allowed: sv["trunk-vlans"], native: sv["native-vlan"] ?? 1}); for (const v of sv["trunk-vlans"]) if (!by.has(v)) by.set(v, []); continue; }
      const v = sv && sv["access-vlan"] || 1; if (!by.has(v)) by.set(v, []); by.get(v).push(p);
    }
    for (const s of svis) { const v = +s.slice(4); if (!by.has(v)) by.set(v, []); }
    const names = M.vlans(ctx.model);
    const addr = {}; for (const s of svis) addr[+s.slice(4)] = (ctx.state().interfaces || []).find(i => i.name === s)?.address || null;
    const vl = [...by.keys()].sort((a, b) => a - b).map(v => ({vlan: v, name: names[v]?.config?.name || (v === 1 ? "default" : `VLAN${String(v).padStart(4, "0")}`), accessPorts: by.get(v), ...(addr[v] !== undefined ? {svi: `vlan${v}`, address: addr[v]} : {})}));
    const text = [table(svis.length ? ["VLAN", "Name", "Access ports", "SVI"] : ["VLAN", "Name", "Access ports"],
      vl.map(r => [r.vlan, r.name, r.accessPorts.join(", ") || "-", ...(svis.length ? [r.svi ? `${r.svi} ${r.address || "(no address)"}` : "-"] : [])])),
      ...(trunks.length ? ["", table(["Trunk", "Allowed VLANs", "Native"], trunks.map(t => [t.port, formatVlanList(t.allowed), t.native]))] : [])].join("\n");
    return {json: {vlans: vl, trunks}, text};
  },

  // One block per interface (or one interface): everything the device knows about it.
  "show.interfaces": (ctx, values) => {
    const names = values && values[0] ? [values[0]] : ctx.ports();
    const st = ctx.state().interfaces || [], relay = M.relayInterfaces(ctx.model);
    const rows = names.map(p => {
      const ifc = M.iface(ctx.model, p, false), live = st.find(x => x.name === p) || {};
      const sv = ifc && M.switchedVlan(ifc, false), sp = ctx.kind === "switch" ? M.stpPort(ctx.model, p, false) : null;
      const addrs = M.addressesOf(ifc || {}).map(a => `${a.ip}/${a.prefixLength}`);
      if (!addrs.length && live.address) addrs.push(live.address);
      const sub = /^(.+)\.(\d+)$/.exec(p), svi = /^vlan(\d+)$/.exec(p);
      const row = {name: p, description: ifc?.config.description ?? null, admin: ifc && ifc.config.enabled === false ? "down" : "up",
        link: live.status ? (live.status === "up" ? "up" : "down") : "unknown", mac: live.mac ?? null,
        addresses: addrs, dhcpClient: !!(ifc && M.dhcpClientOf(ifc))};
      if (sub && ctx.kind !== "switch") Object.assign(row, {parent: sub[1], vlan: +sub[2]});
      if (svi && ctx.kind === "switch") row.vlan = +svi[1];
      if (sv && sv["interface-mode"]) Object.assign(row, {vlanMode: sv["interface-mode"].toLowerCase(),
        ...(sv["interface-mode"] === "TRUNK" ? {trunkVlans: sv["trunk-vlans"], nativeVlan: sv["native-vlan"] ?? 1} : {accessVlan: sv["access-vlan"] ?? 1})});
      if (sp) row.stp = {cost: sp.cost ?? null, portPriority: sp["port-priority"] ?? null};
      const shaper = ifc && ifc["openpacketrouter:shaper"];
      if (shaper) row.shaper = {rate: shaper.rate, burst: shaper.burst, limit: shaper.limit};
      const helpers = relay[p]?.config["helper-address"];
      if (helpers && helpers.length) row.helperAddresses = helpers;
      return row;
    });
    const text = rows.map(r => [
      `${r.name} is ${r.admin === "down" ? "administratively down" : r.link}${r.description ? `, ${r.description}` : ""}`,
      ...(r.mac ? [`  MAC address ${r.mac}`] : []),
      ...(r.parent ? [`  802.1Q subinterface of ${r.parent}, VLAN ${r.vlan}`] : r.vlan && !r.vlanMode ? [`  Layer 3 interface for VLAN ${r.vlan}`] : []),
      ...r.addresses.map(a => `  IPv4 address ${a}`),
      ...(r.dhcpClient && !r.addresses.length ? ["  IPv4 address from DHCP (none yet)"] : []),
      ...(r.vlanMode === "trunk" ? [`  Trunk, allowed VLANs ${formatVlanList(r.trunkVlans)}, native VLAN ${r.nativeVlan}`] : r.vlanMode ? [`  Access port in VLAN ${r.accessVlan}`] : []),
      ...(r.stp ? [`  Spanning tree cost ${r.stp.cost ?? "default"}, port priority ${r.stp.portPriority ?? "default"}`] : []),
      ...(r.shaper ? [`  Shaper: rate ${r.shaper.rate}, burst ${r.shaper.burst}, queue limit ${r.shaper.limit}`] : []),
      ...(r.helperAddresses ? [`  DHCP relay to ${r.helperAddresses.join(", ")}`] : []),
    ].join("\n")).join("\n\n");
    return {json: values && values[0] ? rows[0] : rows, text};
  },

  "show.ospf-neighbor": ctx => {
    const o = ctx.state().ospf; if (!o) return {json: null, text: "OSPF is not running on this router"};
    return {json: o.neighbors, text: o.neighbors.length ? table(["Neighbor ID", "State", "Role", "Address", "Interface"], o.neighbors.map(n => [n.routerId, n.state, n.role, n.address, n.iface])) : "No OSPF neighbors yet"};
  },
  "show.ospf-interface": ctx => {
    const o = ctx.state().ospf; if (!o) return {json: null, text: "OSPF is not running on this router"};
    return {json: o.interfaces, text: o.interfaces.length ? table(["Interface", "State", "Type", "Cost", "Priority", "DR", "BDR"], o.interfaces.map(i => [i.iface, i.state, i.type, i.cost, i.priority, i.dr, i.bdr])) : "OSPF is running on no interface yet"};
  },
  "show.ospf-route": ctx => {
    const o = ctx.state().ospf; if (!o) return {json: null, text: "OSPF is not running on this router"};
    return {json: o.routes, text: o.routes.length ? table(["Network", "Cost", "Via"], o.routes.map(r => [r.network, r.cost, r.via.map(v => `${v.gw} (${v.iface})`).join(", ")])) : "OSPF has computed no routes yet"};
  },
  "show.ospf-database": ctx => {
    const o = ctx.state().ospf; if (!o) return {json: null, text: "OSPF is not running on this router"};
    return {json: o.database, text: o.database.length ? table(["Type", "Link ID", "Advertised by", "Seq"], o.database.map(l => [l.type, l.id, l.adv, l.seq])) : "The link-state database is empty"};
  },

  "show.dhcp-binding": ctx => {
    const rows = ctx.state().leases || [];
    return {json: rows, text: rows.length ? table(["Address", "Client MAC"], rows.map(r => [r.ip, r.mac])) : "No addresses handed out yet"};
  },
};
