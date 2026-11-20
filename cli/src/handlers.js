// Configuration handlers. Each gets a context {model, s (session selection: iface, pool …), kind} and the parsed
// argument values, edits ctx.model (a copy) and may return {out}. Throwing an Error refuses the command with its
// message. A handler name may carry a parameter after a colon ("stp.set:hello-time"), so one function serves a
// family of commands.

import * as M from "./model.js";
import {maskToPrefix, networkOf, isPrefix, prefixToMask} from "./types.js";

const need = (cond, msg) => { if (!cond) throw new Error(msg); };
const cidrOf = (args) => {   // [prefix] or [ip, mask]
  if (args.length === 1 || isPrefix(args[0])) { const [ip, p] = args[0].split("/"); return {ip, p: +p, rest: args.slice(1)}; }
  return {ip: args[0], p: maskToPrefix(args[1]), rest: args.slice(2)};
};
const curIface = ctx => { need(ctx.s.iface, "No interface selected"); return M.iface(ctx.model, ctx.s.iface); };
const pool = ctx => { need(ctx.s.pool, "No DHCP pool selected"); return M.services(ctx.model)["dhcp-server"].pools[ctx.s.pool]; };
const STP_LEAVES = {"bridge-priority": 1, "hello-time": 1, "max-age": 1, "forwarding-delay": 1, "openpacketrouter:bridge-address": 1};

export const HANDLERS = {
  "system.hostname": (ctx, [name]) => { ctx.model.system.config.hostname = name; },

  // ---- interfaces
  "interface.select": (ctx, [name]) => { M.iface(ctx.model, name); ctx.s.iface = name; },
  "interface.shutdown": ctx => { curIface(ctx).config.enabled = false; },
  "interface.no-shutdown": ctx => { curIface(ctx).config.enabled = true; },
  "interface.description": (ctx, [text]) => { curIface(ctx).config.description = text; },
  "interface.no-description": ctx => { delete curIface(ctx).config.description; },

  "ipv4.address.set": (ctx, args) => {
    const {ip, p} = cidrOf(args);
    need(p !== null, "That is not a valid network mask");
    need(networkOf(ip, p) !== ip || p >= 31, `${ip}/${p} is the network itself, not a host address on it`);
    const v4 = M.ipv4(curIface(ctx));
    v4.addresses.address = {[ip]: {config: {ip, "prefix-length": p}}};
    v4.config["dhcp-client"] = false;
  },
  "ipv4.address.dhcp": ctx => { const v4 = M.ipv4(curIface(ctx)); v4.addresses.address = {}; v4.config["dhcp-client"] = true; },
  "ipv4.address.remove": ctx => {
    const ifc = curIface(ctx), v4 = M.ipv4(ifc, false);
    need(v4 && (Object.keys(v4.addresses.address).length || v4.config["dhcp-client"]), "This interface has no address");
    v4.addresses.address = {}; v4.config["dhcp-client"] = false;
  },

  // ---- static routes (FRRouting style: ip route PREFIX NEXTHOP; the mask form is accepted too)
  "static.add": (ctx, args) => {
    const {ip, p, rest: [via]} = cidrOf(args);
    need(p !== null, "That is not a valid network mask");
    const prefix = `${networkOf(ip, p)}/${p}`;
    const r = M.statics(ctx.model)[prefix] ||= {prefix, config: {prefix}, "next-hops": {"next-hop": {}}};
    r["next-hops"]["next-hop"][via] = {index: via, config: {index: via, "next-hop": via}};
  },
  "static.remove": (ctx, args) => {
    const {ip, p, rest: [via]} = cidrOf(args);
    const prefix = `${networkOf(ip, p)}/${p}`, all = M.statics(ctx.model), r = all[prefix];
    need(r && (!via || r["next-hops"]["next-hop"][via]), `There is no static route to ${prefix}${via ? ` via ${via}` : ""}`);
    if (via) delete r["next-hops"]["next-hop"][via]; else delete all[prefix];
    if (all[prefix] && !Object.keys(all[prefix]["next-hops"]["next-hop"]).length) delete all[prefix];
  },
  "static.default": (ctx, [via]) => HANDLERS["static.add"](ctx, ["0.0.0.0/0", via]),
  "static.no-default": ctx => { need(M.statics(ctx.model)["0.0.0.0/0"], "There is no default gateway"); delete M.statics(ctx.model)["0.0.0.0/0"]; },

  // ---- switch ports (openconfig-vlan switched-vlan)
  "switchport.mode": (ctx, args, mode) => {
    const c = M.switchedVlan(curIface(ctx));
    if (mode === "access") { c["interface-mode"] = "ACCESS"; c["access-vlan"] ??= 1; delete c["trunk-vlans"]; delete c["native-vlan"]; }
    else { c["interface-mode"] = "TRUNK"; c["trunk-vlans"] ??= [1]; delete c["access-vlan"]; }
  },
  "switchport.access-vlan": (ctx, [v]) => {
    const c = M.switchedVlan(curIface(ctx));
    need(c["interface-mode"] !== "TRUNK", "This port is a trunk: set switchport mode access first");
    c["interface-mode"] = "ACCESS"; c["access-vlan"] = v;
  },
  "switchport.no-access-vlan": ctx => { const c = M.switchedVlan(curIface(ctx)); if (c["interface-mode"] === "ACCESS") c["access-vlan"] = 1; },
  "switchport.trunk-allowed": (ctx, [list]) => {
    const c = M.switchedVlan(curIface(ctx));
    need(c["interface-mode"] === "TRUNK", "Set switchport mode trunk first");
    c["trunk-vlans"] = list;
  },
  "switchport.trunk-native": (ctx, [v]) => {
    const c = M.switchedVlan(curIface(ctx));
    need(c["interface-mode"] === "TRUNK", "Set switchport mode trunk first");
    c["native-vlan"] = v;
  },
  "switchport.no-trunk-native": ctx => { delete M.switchedVlan(curIface(ctx))["native-vlan"]; },
  "switchport.remove": ctx => { const ifc = curIface(ctx); if (ifc.ethernet) delete ifc.ethernet["switched-vlan"]; },

  // ---- spanning tree (openconfig-spanning-tree)
  "stp.enable": ctx => { M.stpGlobal(ctx.model)["enabled-protocol"] = ["STP"]; },
  "stp.disable": ctx => { ctx.model.stp = M.emptyModel("").stp; },
  "stp.set": (ctx, [v], leaf) => { need(STP_LEAVES[leaf], `unknown setting ${leaf}`); M.stpGlobal(ctx.model)[leaf] = v; },
  "stp.unset": (ctx, args, leaf) => { delete M.stpGlobal(ctx.model)[leaf]; },
  "stp.port.set": (ctx, [v], leaf) => { M.stpPort(ctx.model, curIface(ctx).config.name)[leaf] = v; },
  "stp.port.unset": (ctx, args, leaf) => { const c = M.stpPort(ctx.model, curIface(ctx).config.name, false); if (c) delete c[leaf]; },

  // ---- MAC address table aging (openconfig fdb mac-aging-time)
  "fdb.aging": (ctx, [v]) => { M.fdb(ctx.model)["mac-aging-time"] = v; },
  "fdb.aging.unset": ctx => { delete M.fdb(ctx.model)["mac-aging-time"]; },

  // ---- link shaping (token bucket on the interface's egress)
  "shaper.set": (ctx, [rate, burst, limit]) => { curIface(ctx)["openpacketrouter:shaper"] = {rate, burst, limit}; },
  "shaper.remove": ctx => { delete curIface(ctx)["openpacketrouter:shaper"]; },

  // ---- DHCP relay (openconfig-relay-agent helper addresses)
  "relay.add": (ctx, [ip]) => { const h = M.relayHelpers(ctx.model, curIface(ctx).config.name); if (!h.includes(ip)) h.push(ip); },
  "relay.remove": (ctx, [ip]) => {
    const name = curIface(ctx).config.name, all = M.relayInterfaces(ctx.model);
    need(all[name], "This interface relays nothing");
    if (ip) all[name].config["helper-address"] = all[name].config["helper-address"].filter(x => x !== ip);
    if (!ip || !all[name].config["helper-address"].length) delete all[name];
  },

  // ---- DNS server: ip dns server + ip host NAME ADDRESS (the names the server answers)
  "dns.server": ctx => { const s = M.services(ctx.model); s.dns ||= {enabled: true, hosts: {}}; s.dns.enabled = true; },
  "dns.no-server": ctx => { const s = M.services(ctx.model); need(s.dns, "There is no DNS server here"); delete s.dns; },
  "dns.host": (ctx, [name, ip]) => { const s = M.services(ctx.model); s.dns ||= {enabled: false, hosts: {}}; s.dns.hosts[name] = ip; },
  "dns.no-host": (ctx, [name]) => { const d = M.services(ctx.model).dns; need(d && name in d.hosts, `No host entry for ${name}`); delete d.hosts[name]; },

  // ---- DHCP server pools
  "dhcp.pool": (ctx, [name]) => {
    const s = M.services(ctx.model); s["dhcp-server"] ||= {pools: {}};
    s["dhcp-server"].pools[name] ||= {}; ctx.s.pool = name;
  },
  "dhcp.no-pool": (ctx, [name]) => {
    const d = M.services(ctx.model)["dhcp-server"]; need(d && d.pools[name], `No DHCP pool named ${name}`);
    delete d.pools[name]; if (!Object.keys(d.pools).length) delete M.services(ctx.model)["dhcp-server"];
  },
  "dhcp.range": (ctx, [a, b]) => { pool(ctx).range = [a, b]; },
  "dhcp.set": (ctx, [v], leaf) => { pool(ctx)[leaf] = leaf === "netmask" ? prefixToMask(maskToPrefix(v)) : v; },
  "dhcp.unset": (ctx, args, leaf) => { delete pool(ctx)[leaf]; },

  // ---- TCP services
  "tcp.echo": (ctx, [port]) => { const s = M.services(ctx.model); s.tcp ||= {}; s.tcp[port] = "echo"; },
  "tcp.no-echo": (ctx, [port]) => { const t = M.services(ctx.model).tcp; need(t && t[port], `Nothing listens on TCP port ${port}`); delete t[port]; if (!Object.keys(t).length) delete M.services(ctx.model).tcp; },
};
