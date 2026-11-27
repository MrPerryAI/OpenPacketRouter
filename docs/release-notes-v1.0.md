# OpenPacketRouter v1.0 release notes (draft)

*Draft kept by the lead. It is not a release: no tag, npm package or GitHub release exists. The owner decides when v1.0 ships.*

OpenPacketRouter is a free, CLI-first network simulator for teaching, a Packet Tracer alternative under Apache-2.0.
What sets it apart is that every protocol it models is checked frame for frame against real Linux software in CI. That
means kernel bridges and routing, FRRouting, dnsmasq, keepalived, lldpd, mstpd, nftables and `tc`. If the engine and Linux disagree on
one frame, one counter or one table row, the check fails.

Get started with the [README quick start](../README.md). The full list of changes is in [CHANGELOG.md](../CHANGELOG.md).

## What you can do with it

- **Build a network** as a JSON or YAML spec, or draw it in the browser Studio. Run actions on it (ping, traceroute,
  DHCP, TCP, cable cuts) and get every frame on every cable.
- **Configure devices from a console** with our own CLI: modes, `?` and Tab help, `show … | json`, and a running config
  that round-trips. The same configuration can be rendered for Linux, FRRouting and OpenWrt, and CI proves that those
  real systems end up with the engine's tables.
- **Teach with ready labs** in `examples/`. Each one has a student guide with commands to try and what to expect.

## Validated features

| Area | Features | Linux reference |
|---|---|---|
| Switching | STP, TCN, RSTP, VLANs and trunks, MAC aging, LACP, LLDP, port security, storm control, DHCP snooping, SPAN | kernel bridge, mstpd, bonding, lldpd, nftables, `tc police`, `tc mirred` |
| Links | capacity, queues and drops, delay, deterministic loss, broadcast storm math | `tbf`, `netem`, kernel bridges |
| IPv4 | ARP, ICMP, static routes, inter-VLAN routing, ACLs, NAT | kernel, nftables, conntrack |
| Services | DHCP and DHCP relay, TCP (retransmission, receive window), HTTP GET, syslog, NTP | dnsmasq, udhcpc, Linux sockets, util-linux `logger`, `ntpdate` |
| Routing | RIPv2, OSPFv2 (several areas, ABRs), VRRP first-hop redundancy | FRRouting ripd, ospfd, keepalived |
| IPv6 | global addresses, neighbor discovery, ICMPv6 echo, static routes | kernel |

## Not validatable, so not built

Some features have no faithful Linux reference. They are recorded in `docs/STATUS.md` and left out on purpose rather than
built unchecked:

- DHCP snooping's binding table, dynamic ARP inspection and IP source guard.
- Random link loss. Only deterministic loss patterns (every probability 0% or 100%) can match `netem` frame for frame.

## Known limits

- IPv6: no link-local routing targets, DAD, MLD, router advertisements or SLAAC yet. The validator turns these off in Linux,
  so they are not part of the comparison.
- OpenWrt backend: proves addresses and static/default routes through real `uci`. VLAN, firewall and DHCP-pool rendering
  are not proven yet, and netifd is not booted.

## Still open for v1.0

The checklist in `docs/STATUS.md` is the source of truth. At the time of writing these items are still open: OSPF
redistribution, BGP basics, RIPng/OSPFv3, full CLI coverage of every spec key, the
remaining FRR backend protocols, and the Studio editor's finishing work.

## Later, not in v1.0

The research ideas in `docs/vision.md` (mixed detail levels, device handoff, git-style state, quirk layers), vendor images
and wireless.
