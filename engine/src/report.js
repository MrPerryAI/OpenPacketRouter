// Plain-English report of a run (the CLI's --text): what each action did, why, and what it cost on the wire.

const ms = t => `${(t * 1000).toFixed(t < 0.01 ? 2 : 1).padStart(8)} ms`;

/** One line describing an action's outcome. */
export function describeResult(a, r) {
  if (a.do === "wait") return `wait ${a.seconds} s (now ${+r.time.toFixed(3)} s)`;
  if (a.do === "macTable") return `MAC table of ${r.switch}: ` + (r.entries.map(e => `vlan ${e.vlan} ${e.mac} on ${e.port} (age ${e.age} s)`).join("; ") || "empty");
  if (a.do === "portSecurity") return `port security on ${r.switch}: ` + (r.ports.map(p => `${p.port} ${p.secured.length}/${p.max} secured, ${p.violations} violation(s), ${p.violation}${p.errdisabled ? ", err-disabled" : ""}`).join("; ") || "off");
  if (a.do === "stormControl") return `storm control on ${r.switch}: ` + (r.ports.map(p => `${p.port} broadcast ${p.broadcast ? `${p.broadcast.passed} passed, ${p.broadcast.dropped} dropped` : "unlimited"}`).join("; ") || "off");
  if (a.do === "stp") return `spanning tree on ${r.switch}: root ${r.root}${r.isRoot ? " (this switch)" : ""}, ` + Object.entries(r.ports).map(([n, p]) => `${n} ${p.role}/${p.state}`).join(" ") + (r.topologyChange ? ", topology change in progress" : "");
  if (a.do === "lacp") return `port-channels on ${r.switch}: ` + (r.channels.map(c => `${c.name} (${c.rate}) ` + c.members.map(m => `${m.port} ${!m.up ? "down" : m.aggregated ? "bundled" : "waiting"}`).join(", ")).join("; ") || "none");
  if (a.do === "dhcpSnooping") return `DHCP snooping on ${r.switch}: trusted ${r.trusted.join(", ") || "none"}; server messages dropped: ` + (Object.entries(r.dropped).map(([p, c]) => `${p} ${c}`).join(", ") || "none");
  if (a.do === "link") return `cable at ${a.end} ${r.up ? "restored" : "cut"}`;
  if (a.do === "vrrpState") return `VRRP on ${a.src} at ${+r.t.toFixed(3)} s: ` + (r.groups.map(g => `${g.iface} group ${g.vrid} (${g.ip}) ${g.state}${g.masterIp ? ", master " + g.masterIp : ""}`).join("; ") || "no groups");
  if (a.do === "lldpNeighbors") return `LLDP neighbors of ${a.src} at ${+r.t.toFixed(3)} s: ` + (r.neighbors.map(n => `${n.iface} sees ${n.sysName} (${n.portDescr})`).join("; ") || "none");
  if (a.do === "ripTable") return `RIP table of ${a.src} at ${+r.t.toFixed(3)} s: ` + (r.routes.map(x => `${x.type} ${x.network}${x.type === "R" ? " via " + x.nextHop : ""} metric ${x.metric}`).join(", ") || "empty");
  if (a.do === "ripRoute") return `${a.network} at ${+r.t.toFixed(3)} s: ` + Object.entries(r.routers).map(([n, x]) =>
    `${n} ${x ? (x.metric === 16 ? "16 (unreachable)" : x.metric) + (x.type === "R" ? " via " + x.nextHop : " (connected)") : "no route"}`).join(" · ");
  const what = a.do === "dns" ? `dns ${a.name} via ${a.server} from ${a.src}` :
    a.do === "udpBurst" ? `${a.count} UDP datagrams of ${a.size} B ${a.src} → ${a.dst}:${a.port}` :
    a.do === "dhcp" ? `dhcp on ${a.src}` : `${a.do} ${a.src} → ${a.dst}${a.port ? ":" + a.port : ""}`;
  let how;
  if (r.hops) how = (r.reached ? "reached: " : "not reached: ") + r.hops.map(h => h.from ?? "*").join(" → ");
  else if (a.do === "udpBurst") how = `${r.sent} sent`;
  else if (r.ok) how = "ok" + (r.answer !== undefined ? `, answer ${r.answer}` : "") + (r.ip ? `, got ${r.ip} from ${r.server} for ${r.lease} s` : "") +
    (r.from && !r.ip ? ` from ${r.from}` : "") + (r.rtt_ms !== undefined ? ` in ${r.rtt_ms} ms` : "");
  else how = `failed: ${r.error}` + (r.from ? ` (from ${r.from})` : "");
  return `${what}: ${how}`;
}

/** Text report for runActions(..., {trace: true}) results. `maxEvents` caps each action's trace. */
export function textReport(specName, results, {maxEvents = 200} = {}) {
  const out = [];
  if (specName) out.push(`# ${specName}`, "");
  results.forEach((e, k) => {
    out.push(`${k + 1}. ${describeResult(e.action, e.result)}`);
    if (e.trace) {
      const t0 = e.trace.length ? e.trace[0].t : 0;
      for (const ev of e.trace.slice(0, maxEvents)) out.push(`   ${ms(ev.t - t0)}  ${ev.node.padEnd(12)} ${ev.detail}`);
      if (e.trace.length > maxEvents) out.push(`   … ${e.trace.length - maxEvents} more decisions`);
    }
    const frames = Object.entries(e.frames).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
    const total = frames.reduce((s, [, v]) => s + v, 0);
    out.push(`   frames: ${total} on ${frames.length} cable direction${frames.length === 1 ? "" : "s"}` +
      (frames.length ? ": " + frames.map(([c, v]) => `${c} ${v}`).join(", ") : ""));
    if (e.drops && Object.keys(e.drops).length) out.push(`   dropped in queues: ${Object.entries(e.drops).map(([i, v]) => `${i} ${v}`).join(", ")}`);
    out.push("");
  });
  return out.join("\n");
}
