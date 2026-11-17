// IPv4 and MAC helpers.

export const BROADCAST_MAC = "ff:ff:ff:ff:ff:ff";

export function ipToInt(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(x => !Number.isInteger(x) || x < 0 || x > 255)) throw new Error(`bad IPv4 address: ${ip}`);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
export const intToIp = n => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
export const maskOf = prefix => prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);

/** "10.1.0.1/24" -> {ip, prefix, net, mask, cidr} (net as an int). */
export function parseCidr(cidr) {
  const [ip, p] = cidr.split("/");
  const prefix = p === undefined ? 32 : Number(p);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new Error(`bad prefix: ${cidr}`);
  const mask = maskOf(prefix);
  return {ip, prefix, mask, net: (ipToInt(ip) & mask) >>> 0, cidr: `${intToIp((ipToInt(ip) & mask) >>> 0)}/${prefix}`};
}
export const inSubnet = (ip, net, mask) => ((ipToInt(ip) & mask) >>> 0) === net;

/** Deterministic, locally administered MAC from a counter. */
export const macFor = n => "02:00:" + [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].map(x => x.toString(16).padStart(2, "0")).join(":");
