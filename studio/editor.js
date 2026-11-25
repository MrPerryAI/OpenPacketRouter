// Pure spec edits for the Studio topology editor (no DOM; Node can import it).
// Every function returns a new spec and leaves its argument alone. Callers validate the result with validateSpec.

const clone = x => JSON.parse(JSON.stringify(x));
const PREFIX = {switch: "SW", router: "R", host: "PC", server: "SRV"};

/** A node name not used yet: SW1, SW2, … */
export function freeName(spec, kind) {
  const used = new Set(spec.nodes.map(n => n.name));
  for (let i = 1; ; i++) if (!used.has(PREFIX[kind] + i)) return PREFIX[kind] + i;
}

/** Ports and interfaces already cabled on a node. */
export const cabledPorts = (spec, node) => spec.links.flatMap(l => l.slice(0, 2)).filter(r => r.startsWith(node + ":")).map(r => r.slice(node.length + 1));

/** The next unused port: p1, p2… on a switch, the first uncabled interface (or a new ethN) elsewhere. */
export function freePort(spec, node) {
  const n = spec.nodes.find(x => x.name === node), used = new Set(cabledPorts(spec, node));
  if (n.kind === "switch") { for (let i = 1; ; i++) if (!used.has("p" + i)) return "p" + i; }
  for (const i of Object.keys(n.ifaces || {})) if (!used.has(i) && !i.startsWith("vlan") && !i.includes(".")) return i;
  for (let i = 0; ; i++) if (!(n.ifaces || {})[`eth${i}`]) return `eth${i}`;
}

export function addNode(spec, kind, name = freeName(spec, kind)) {
  const s = clone(spec), n = {name, kind};
  if (kind !== "switch") n.ifaces = {};
  s.nodes.push(n); return s;
}

/** Cable a:pa to b:pb (ports default to the next free ones). A new interface on a host, router or server starts as "dhcp". */
export function addLink(spec, a, b, pa, pb) {
  if (a === b) throw new Error("A cable needs two different devices");
  const s = clone(spec);
  pa = pa || freePort(s, a); pb = pb || freePort(s, b);
  for (const [node, port] of [[a, pa], [b, pb]]) {
    const n = s.nodes.find(x => x.name === node);
    if (cabledPorts(s, node).includes(port)) throw new Error(`${node}:${port} is already cabled`);
    if (n.kind !== "switch") { n.ifaces = n.ifaces || {}; if (!(port in n.ifaces)) n.ifaces[port] = "dhcp"; }
  }
  s.links.push([`${a}:${pa}`, `${b}:${pb}`]); return s;
}

export function removeLink(spec, i) { const s = clone(spec); s.links.splice(i, 1); return s; }

/** Remove a device, its cables, and the actions that mention it (returned as `actions`). */
export function removeNode(spec, name, actions = []) {
  const s = clone(spec);
  s.nodes = s.nodes.filter(n => n.name !== name);
  s.links = s.links.filter(l => !l.slice(0, 2).some(r => r.startsWith(name + ":")));
  return {spec: s, actions: actions.filter(a => !Object.values(a).includes(name))};
}

export function renameNode(spec, old, name, actions = []) {
  if (!name || name.includes(":")) throw new Error("A hostname is not empty and has no ':'");
  if (name !== old && spec.nodes.some(n => n.name === name)) throw new Error(`There is already a device named ${name}`);
  const s = clone(spec);
  s.nodes.find(n => n.name === old).name = name;
  s.links = s.links.map(l => l.map((x, i) => i < 2 && x.startsWith(old + ":") ? name + x.slice(old.length) : x));
  return {spec: s, actions: actions.map(a => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v === old ? name : v])))};
}

/** Set an interface address ("10.0.0.1/24", "dhcp"); empty text removes an uncabled interface. */
export function setAddress(spec, node, iface, text) {
  const s = clone(spec), n = s.nodes.find(x => x.name === node);
  n.ifaces = n.ifaces || {};
  if (text.trim() === "") delete n.ifaces[iface]; else n.ifaces[iface] = text.trim();
  return s;
}

export function setGateway(spec, node, text) {
  const s = clone(spec), n = s.nodes.find(x => x.name === node);
  if (text.trim()) n.gw = text.trim(); else delete n.gw;
  return s;
}

/** VLAN of a switch port: text "10" (access) or "trunk 10,20" / "trunk 10,20 native 1"; "" returns it to access 1. */
export function setVlan(spec, node, port, text) {
  const s = clone(spec), n = s.nodes.find(x => x.name === node), t = text.trim().toLowerCase();
  let cfg;
  if (t === "") cfg = null;
  else if (/^\d+$/.test(t)) cfg = {access: +t};
  else { const m = /^trunk\s+([\d,\s]+?)(?:\s+native\s+(\d+))?$/.exec(t);
    if (!m) throw new Error('VLAN is a number (access) or "trunk 10,20" (optionally "native 1")');
    cfg = {trunk: m[1].split(/[\s,]+/).filter(Boolean).map(Number)}; if (m[2]) cfg.native = +m[2]; }
  if (cfg === null) { if (n.vlans) { delete n.vlans[port]; if (!Object.keys(n.vlans).length) delete n.vlans; } }
  else { n.vlans = n.vlans || {}; n.vlans[port] = cfg; }
  return s;
}
