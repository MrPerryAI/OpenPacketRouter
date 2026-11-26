// NTP (RFC 5905), client and server mode, over UDP 123. The engine has one clock, so a server's timestamps equal the client's and
// the measured offset is 0; the delay is the round trip over the cables. Validated against chronyd (server) and ntpdate (client)
// in validate/services.

/** What a server with `cfg = {stratum}` answers to a client packet (null for anything that is not a client request). */
export function ntpServe(node, cfg, req) {
  const q = req && req.ntp;
  if (!q || q.mode !== 3) return undefined;
  const now = node.net.time;
  return {ntp: {leap: 0, version: q.version, mode: 4, stratum: cfg.stratum, poll: q.poll, t1: q.t3, t2: now, t3: now}};
}
