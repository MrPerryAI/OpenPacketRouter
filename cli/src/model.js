// The configuration model: the contract between commands and backends (docs/cli-design.md).
//
// It follows OpenConfig's tree and leaf names (system, interfaces, network-instances, stp, relay-agent). Keyed
// lists are stored as objects keyed by the list key, which makes them easy to edit; toOpenConfig() converts them
// to the standard JSON encoding (lists of entries) for export. Things OpenConfig has no model for live under
// "openpacketrouter:" keys.

export const clone = o => JSON.parse(JSON.stringify(o));
const own = (o, k, init) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : (o[k] = init));

export function emptyModel(hostname) {
  return {
    system: {config: {hostname}},
    interfaces: {interface: {}},
    "network-instances": {"network-instance": {default: {
      config: {name: "default"},
      protocols: {protocol: {STATIC: {"static-routes": {static: {}}}}},
      vlans: {vlan: {}},
    }}},
    stp: {global: {config: {}}, interfaces: {interface: {}}},
    "relay-agent": {dhcp: {interfaces: {interface: {}}}},
    "openpacketrouter:services": {},
  };
}

// ---- accessors (create on the way down when `make`)

export const hostname = m => m.system.config.hostname;
export const interfaces = m => m.interfaces.interface;
export function iface(m, name, make = true) {
  const all = interfaces(m);
  if (!all[name]) { if (!make) return null; all[name] = {config: {name, enabled: true}}; }
  return all[name];
}
/** The IPv4 container of an interface's untagged subinterface (index 0), as in openconfig-if-ip. */
export function ipv4(ifc, make = true) {
  if (!make && !ifc.subinterfaces?.subinterface?.["0"]?.ipv4) return null;
  const sub = own(own(own(ifc, "subinterfaces", {}), "subinterface", {}), "0", {config: {index: 0}});
  return own(sub, "ipv4", {addresses: {address: {}}, config: {"dhcp-client": false}});
}
/** The IPv6 container of an interface's untagged subinterface (openconfig-if-ip). */
export function ipv6(ifc, make = true) {
  if (!make && !ifc.subinterfaces?.subinterface?.["0"]?.ipv6) return null;
  const sub = own(own(own(ifc, "subinterfaces", {}), "subinterface", {}), "0", {config: {index: 0}});
  return own(sub, "ipv6", {addresses: {address: {}}});
}
export const addressesOf6 = ifc => Object.values(ipv6(ifc, false)?.addresses.address || {}).map(a => ({ip: a.config.ip, prefixLength: a.config["prefix-length"]}));
/** [{ip, prefixLength}] of an interface. */
export const addressesOf = ifc => Object.values(ipv4(ifc, false)?.addresses.address || {}).map(a => ({ip: a.config.ip, prefixLength: a.config["prefix-length"]}));
export const dhcpClientOf = ifc => !!ipv4(ifc, false)?.config["dhcp-client"];
export const switchedVlan = (ifc, make = true) => make ? own(own(own(ifc, "ethernet", {}), "switched-vlan", {}), "config", {}) : ifc.ethernet?.["switched-vlan"]?.config || null;

const ni = m => m["network-instances"]["network-instance"].default;
/** Static routes: {prefix: {"next-hops": {"next-hop": {index: {config: {"next-hop": ip}}}}}} in the order they were added. */
export const statics = m => ni(m).protocols.protocol.STATIC["static-routes"].static;
const isV6 = prefix => prefix.includes(":");   // IPv6 and IPv4 static routes share one table, told apart by the prefix
export const staticList = m => Object.entries(statics(m)).filter(([prefix]) => !isV6(prefix)).flatMap(([prefix, r]) => Object.values(r["next-hops"]["next-hop"]).map(h => ({prefix, nextHop: h.config["next-hop"]})));
export const staticList6 = m => Object.entries(statics(m)).filter(([prefix]) => isV6(prefix)).flatMap(([prefix, r]) => Object.values(r["next-hops"]["next-hop"]).map(h => ({prefix, nextHop: h.config["next-hop"]})));
/** OSPFv2 (openconfig-ospfv2): null until `router ospf`. Its networks are under "openpacketrouter:networks" (OpenConfig selects interfaces per area instead). */
export const ospf = (m, make = false) => {
  const all = ni(m).protocols.protocol;
  if (!all.OSPF) { if (!make) return null; all.OSPF = {identifier: "OSPF", config: {identifier: "OSPF", name: "ospf"}, ospfv2: {global: {config: {}}, "openpacketrouter:networks": [], "openpacketrouter:redistribute": [], areas: {area: {"0": {interfaces: {interface: {}}}}}}}; }
  return all.OSPF.ospfv2;
};
export const ospfDelete = m => { delete ni(m).protocols.protocol.OSPF; };
/** One interface's OSPF settings: {config: {metric, priority, "network-type"}, timers: {config: {...}}}. */
export const ospfIf = (m, name, make = true) => {
  const all = ospf(m, make)?.areas.area["0"].interfaces.interface; if (!all) return null;
  if (!all[name]) { if (!make) return null; all[name] = {config: {id: name}, timers: {config: {}}}; }
  return all[name];
};
export const vlans = m => ni(m).vlans.vlan;
/** MAC table settings (openconfig-network-instance fdb): config["mac-aging-time"] in seconds; absent = the default (300). */
export const fdb = m => (ni(m).fdb ||= {config: {}}).config;

/** Port mirroring sessions (openconfig-mirror-like): {"1": {destination: "p3", sources: {p1: "rx"|"tx"|"both"}}}; absent = none. */
export const monitor = (m, make = true) => make ? (m.monitor ||= {}) : (m.monitor || {});

/** Link aggregation (openconfig-if-aggregate / openconfig-lacp): a member port has ethernet.config["aggregate-id"] = "Po1";
 *  the port-channel is an interface of its own (type ieee8023adLag); its LACP interval (FAST/SLOW) lives under lacp.interfaces. */
export const lagOf = ifc => ifc?.ethernet?.config?.["aggregate-id"];
export const setLag = (ifc, id) => { own(own(ifc, "ethernet", {}), "config", {})["aggregate-id"] = id; };
export const clearLag = ifc => { if (ifc?.ethernet?.config) delete ifc.ethernet.config["aggregate-id"]; };
export const isLagName = n => /^Po\d+$/.test(n);
export const lacpInterval = (m, name, make = true) => {
  const all = ((m.lacp ||= {interfaces: {interface: {}}}).interfaces.interface);
  if (!all[name]) { if (!make) return null; all[name] = {name, config: {name}}; }
  return all[name].config;
};

export const stpGlobal = m => m.stp.global.config;
export const stpEnabled = m => (stpGlobal(m)["enabled-protocol"] || []).length > 0;
export const stpPort = (m, p, make = true) => {
  const all = m.stp.interfaces.interface;
  if (!all[p]) { if (!make) return null; all[p] = {config: {name: p}}; }
  return all[p].config;
};
export const relayInterfaces = m => m["relay-agent"].dhcp.interfaces.interface;
export function relayHelpers(m, name, make = true) {
  const all = relayInterfaces(m);
  if (!all[name]) { if (!make) return []; all[name] = {config: {id: name, "helper-address": []}}; }
  return all[name].config["helper-address"];
}
export const services = m => m["openpacketrouter:services"];

// ---- export

const LIST_KEYS = {"interface": "name", "subinterface": "index", "address": "ip", "static": "prefix", "next-hop": "index",
  "protocol": "identifier", "area": "identifier", "network-instance": "name", "vlan": "vlan-id"};

/** The model in OpenConfig's standard JSON encoding: keyed objects become lists of entries with their key leaf. */
export function toOpenConfig(m) {
  const walk = (node, key) => {
    if (Array.isArray(node)) return node.map(x => walk(x));
    if (!node || typeof node !== "object") return node;
    if (key && LIST_KEYS[key] && !key.startsWith("openpacketrouter:")) {
      const k = LIST_KEYS[key];
      return Object.entries(node).map(([id, v]) => ({[k]: /^\d+$/.test(id) && k !== "ip" && k !== "prefix" ? +id : id, ...walk(v)}));
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = k.startsWith("openpacketrouter:") ? clone(v) : walk(v, k);
    return out;
  };
  const o = walk(m);
  return {
    "openconfig-system:system": o.system,
    "openconfig-interfaces:interfaces": o.interfaces,
    "openconfig-network-instance:network-instances": o["network-instances"],
    "openconfig-spanning-tree:stp": o.stp,
    "openconfig-relay-agent:relay-agent": o["relay-agent"],
    "openpacketrouter:services": o["openpacketrouter:services"],
  };
}
