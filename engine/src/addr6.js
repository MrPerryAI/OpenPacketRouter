// IPv6 address helpers: parse "2001:db8::1/64", format in the compressed form Linux prints, solicited-node multicast.

/** "2001:db8::1" -> BigInt (128 bits). */
export function ip6ToInt(s) {
  if (typeof s !== "string" || /[^0-9a-fA-F:]/.test(s) || (s.match(/::/g) || []).length > 1) throw new Error(`bad IPv6 address: ${s}`);
  const [head, tail] = s.split("::");
  const h = head === "" ? [] : head.split(":"), t = tail === undefined ? null : (tail === "" ? [] : tail.split(":"));
  const groups = t === null ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-fA-F]{1,4}$/.test(g))) throw new Error(`bad IPv6 address: ${s}`);
  return groups.reduce((a, g) => (a << 16n) | BigInt(parseInt(g, 16)), 0n);
}
/** BigInt -> compressed text (RFC 5952: longest run of zero groups, at least two, becomes "::"). */
export function intToIp6(n) {
  const g = Array.from({length: 8}, (_, i) => Number((n >> BigInt(16 * (7 - i))) & 0xffffn));
  let best = {at: -1, len: 0};
  for (let i = 0; i < 8;) { if (g[i]) { i++; continue; } let j = i; while (j < 8 && !g[j]) j++; if (j - i > best.len) best = {at: i, len: j - i}; i = j; }
  const hex = x => x.toString(16);
  if (best.len < 2) return g.map(hex).join(":");
  return g.slice(0, best.at).map(hex).join(":") + "::" + g.slice(best.at + best.len).map(hex).join(":");
}
export const normIp6 = s => intToIp6(ip6ToInt(s));
export const maskOf6 = prefix => prefix === 0 ? 0n : (((1n << 128n) - 1n) << BigInt(128 - prefix)) & ((1n << 128n) - 1n);

/** "2001:db8::1/64" -> {ip, prefix, net, mask, cidr}. */
export function parseCidr6(cidr) {
  const [ip, p] = cidr.split("/"), prefix = p === undefined ? 128 : Number(p);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) throw new Error(`bad prefix: ${cidr}`);
  const v = ip6ToInt(ip), mask = maskOf6(prefix), net = v & mask;
  return {ip: intToIp6(v), prefix, mask, net, cidr: `${intToIp6(net)}/${prefix}`};
}
export const inSubnet6 = (ip, net, mask) => (ip6ToInt(ip) & mask) === net;
export const isIp6 = s => { try { ip6ToInt(s); return true; } catch { return false; } };
export const isCidr6 = s => { try { parseCidr6(s); return typeof s === "string" && s.includes(":"); } catch { return false; } };

/** ff02::1:ffXX:XXXX for the low 24 bits of an address, and its Ethernet multicast MAC 33:33:ff:XX:XX:XX. */
export const solicitedNode = ip => intToIp6(ip6ToInt("ff02::1:ff00:0") | (ip6ToInt(ip) & 0xffffffn));
export const multicastMac = ip => { const v = ip6ToInt(ip) & 0xffffffffn; return "33:33:" + [24n, 16n, 8n, 0n].map(s => ((v >> s) & 255n).toString(16).padStart(2, "0")).join(":"); };
export const ALL_NODES = "ff02::1";
