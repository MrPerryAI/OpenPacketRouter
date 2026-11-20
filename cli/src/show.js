// Show handlers. Each returns {text, json}: `| json` prints json, so every show command has a JSON form by
// construction. ctx: {model, kind, ports, device, backend, state()}.

import * as M from "./model.js";
import {runningConfig} from "./render.js";
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
    const code = r => r.protocol === "connected" ? "C" : "S";
    const lines = ["Legend: C = connected network, S = static route", ""];
    for (const r of rows) lines.push(r.protocol === "connected"
      ? `C  ${r.prefix} on ${r.interface} (directly connected)`
      : `${code(r)}  ${r.prefix} via ${r.nextHop}${r.interface ? `, out ${r.interface}` : ", next hop not on any connected network"}`);
    if (!rows.length) lines.push("(no routes)");
    return {json: rows, text: lines.join("\n")};
  },

  "show.arp": ctx => {
    const rows = ctx.state().arp || [];
    return {json: rows, text: rows.length ? table(["Address", "MAC", "Interface"], rows.map(r => [r.ip, r.mac, r.interface]))
      : "ARP table is empty (it fills when this device sends or answers traffic: try ping)"};
  },

  "show.mac-table": ctx => {
    const rows = ctx.state().mac || [];
    return {json: rows, text: rows.length ? table(["VLAN", "MAC", "Port"], rows.map(r => [r.vlan, r.mac, r.port])) + `\n${rows.length} entries`
      : "MAC table is empty (it fills as frames arrive: try a ping between two hosts)"};
  },

  "show.spanning-tree": ctx => {
    const d = ctx.state().stp;
    if (!d) return {json: null, text: "Spanning tree is off on this switch"};
    const lines = [`Bridge ${d.bridgeId}${d.isRoot ? "  (this switch is the root)" : ""}`, `Root   ${d.root}`];
    if (!d.isRoot) lines.push(`Path cost to root ${d.rootCost}, through port ${d.rootPort}`);
    lines.push("", table(["Port", "Role", "State", "Cost", "Port ID"], Object.entries(d.ports).map(([p, x]) => [p, x.role, x.state, x.cost, `${x.id >> 8}.${x.no}`])));
    return {json: d, text: lines.join("\n")};
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

  "show.dhcp-binding": ctx => {
    const rows = ctx.state().leases || [];
    return {json: rows, text: rows.length ? table(["Address", "Client MAC"], rows.map(r => [r.ip, r.mac])) : "No addresses handed out yet"};
  },
};
