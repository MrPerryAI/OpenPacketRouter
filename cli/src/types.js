// Argument types for command definitions ("args": {"PREFIX": "ipv4-prefix"}).
// Each type: {hint, help, test(word, ctx) -> boolean, normalize?(word, ctx) -> value, complete?(ctx) -> [words]}.
// `hint` is what `?` shows in place of the argument; `help` is the default help line for it.

const IP_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
export const isIp = s => IP_RE.test(s) && s.split(".").every(o => +o <= 255);
export const ipToInt = s => s.split(".").reduce((a, o) => a * 256 + +o, 0) >>> 0;
export const intToIp = n => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
export const prefixToMask = p => intToIp(p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0);
export function maskToPrefix(m) {
  if (!isIp(m)) return null;
  const bits = ipToInt(m).toString(2).padStart(32, "0");
  return /^1*0*$/.test(bits) ? (bits.indexOf("0") === -1 ? 32 : bits.indexOf("0")) : null;
}
export const networkOf = (ip, p) => intToIp(p === 0 ? 0 : (ipToInt(ip) & ((0xffffffff << (32 - p)) >>> 0)) >>> 0);
export const isPrefix = s => { const [ip, p, ...r] = String(s).split("/"); return !r.length && isIp(ip) && /^\d{1,2}$/.test(p ?? "") && +p <= 32; };

/** "10,20,30-32" -> [10, 20, 30, 31, 32] (sorted, unique), or null. */
export function parseVlanList(s) {
  if (!/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(s)) return null;
  const out = new Set();
  for (const part of s.split(",")) {
    const [a, b = a] = part.split("-").map(Number);
    if (a < 1 || b > 4094 || a > b || b - a > 4094) return null;
    for (let v = a; v <= b; v++) out.add(v);
  }
  return [...out].sort((x, y) => x - y);
}
/** [10, 20, 21, 22] -> "10,20-22" */
export function formatVlanList(list) {
  const v = [...list].sort((a, b) => a - b), out = [];
  for (let i = 0; i < v.length; i++) {
    let j = i; while (j + 1 < v.length && v[j + 1] === v[j] + 1) j++;
    out.push(j - i >= 2 ? `${v[i]}-${v[j]}` : j === i ? `${v[i]}` : `${v[i]},${v[j]}`); i = j;
  }
  return out.join(",");
}

/** "any", "10.0.0.5", "10.0.0.0/24", each optionally followed by ":80" or ":8000-9100" -> {addr, port} | null. */
export function aclEndpoint(s) {
  const m = /^([^:]+)(?::(\d+(?:-\d+)?))?$/.exec(s); if (!m) return null;
  const [, a, p] = m;
  if (a !== "any" && !isIp(a) && !isPrefix(a)) return null;
  let port;
  if (p !== undefined) {
    const [lo, hi = lo] = p.split("-").map(Number);
    if (lo > 65535 || hi > 65535 || lo > hi) return null;
    port = p.includes("-") ? p : +p;
  }
  return {addr: a === "any" ? undefined : a, port};
}

const uint = (lo, hi) => ({hint: `<${lo}-${hi}>`, help: "Number", test: s => /^\d+$/.test(s) && +s >= lo && +s <= hi, normalize: s => +s});

/** Interface names: a known port (exact, or a unique prefix of one), or a new name where the device allows it. */
// VLAN interfaces (SVI vlan10) and subinterfaces (eth0.10) may be created by naming them
const VIFNAME_RE = /^(vlan\d+|Po\d+|[A-Za-z][A-Za-z0-9_-]*\.\d+)$/;
const IFNAME_RE = /^[A-Za-z][\w./-]*$/;
function matchPort(word, ctx) {
  const ports = ctx.ports();
  if (ports.includes(word)) return word;
  const hits = ports.filter(p => p.toLowerCase().startsWith(word.toLowerCase()));
  return hits.length === 1 ? hits[0] : null;
}

export const TYPES = {
  "ipv4-address": {hint: "A.B.C.D", help: "IPv4 address", test: isIp},
  "ipv4-mask": {hint: "A.B.C.D", help: "Network mask", test: s => maskToPrefix(s) !== null},
  "ipv4-prefix": {hint: "A.B.C.D/M", help: "IPv4 network and prefix length", test: isPrefix},
  "vlan-id": {...uint(1, 4094), help: "VLAN number"},
  "vlan-list": {hint: "VLAN-LIST", help: "VLANs, like 10,20,30-35", test: s => parseVlanList(s) !== null, normalize: parseVlanList},
  "word": {hint: "WORD", help: "Name", test: s => /^[A-Za-z][\w.-]*$/.test(s)},
  "hostname": {hint: "WORD", help: "Device name", test: s => /^[A-Za-z][\w-]*$/.test(s)},
  "rate": {hint: "RATE", help: "Rate, like 1mbit, 500kbit or 1gbit", test: s => /^\d+(\.\d+)?(bit|kbit|mbit|gbit)$/i.test(s), normalize: s => s.toLowerCase()},
  "mac": {hint: "H:H:H:H:H:H", help: "MAC address", test: s => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(s), normalize: s => s.toLowerCase()},
  "ifname": {
    hint: "IFNAME", help: "Interface name",
    test: (s, ctx) => matchPort(s, ctx) !== null || (ctx.canCreatePorts && IFNAME_RE.test(s)) || VIFNAME_RE.test(s),
    normalize: (s, ctx) => matchPort(s, ctx) ?? s,
    complete: ctx => ctx.ports(),
  },
  "acl-endpoint": {hint: "any|HOST|PREFIX[:PORT]", help: "who: any, one address, or a prefix; tcp/udp may add :PORT or :LOW-HIGH", test: s => aclEndpoint(s) !== null},
  "port": {...uint(1, 65535), help: "Port number"},
  "seconds": {...uint(1, 31536000), help: "Seconds"},
  "bytes": {...uint(1, 1e9), help: "Bytes"},
};
// "uint:LOW-HIGH" is built on demand.
export function typeOf(name) {
  if (TYPES[name]) return TYPES[name];
  const m = /^uint:(\d+)-(\d+)$/.exec(name);
  if (m) return (TYPES[name] = uint(+m[1], +m[2]));
  return null;
}
