# Changelog

All notable changes to OpenPacketRouter. Every feature listed under "Validated" is compared frame for frame against
real Linux (kernel, FRRouting, dnsmasq, keepalived, …) in CI; see `validate/` and `docs/STATUS.md`.

Versions are not tagged or published yet: the owner decides when v1.0 is released.

## Unreleased (v1.0 candidate)

### Engine: switching (validated vs Linux bridges and tools)

- Spanning tree with real BPDUs, VLANs and trunks (#11); tie-breaks on parallel cables and equal-cost paths (#15).
- Topology change notices: TCN BPDUs, the TC flag and fast MAC aging (#69, validator plateaus #86).
- RSTP (802.1w), checked against mstpd in CI (#122).
- MAC address aging against the bridge `ageing_time` (#58).
- LACP link aggregation (802.3ad port-channels) against kernel bonds (#78).
- LLDP against lldpd: neighbor tables, LLDPDU contents and exact per-cable counts (#82, #87).
- Port security against nftables (#132). Storm control (broadcast policer) against `tc police` (#141).
- SPAN port mirroring against `tc mirred` (#144).
- DHCP snooping (server messages dropped on untrusted ports) against nftables bridge rules with dnsmasq and udhcpc (#164).
- Inter-VLAN routing: router on a stick and Layer 3 switch SVIs (#55).

### Engine: links

- Storm math inside the engine, including steady per-cable storm rates and shaped link capacity (#6, #18, #19).
- Link capacity, queues and drops against `tbf` (#13).
- Link delay and deterministic loss against `tc netem` (#135). Random loss can't be matched frame for frame, so the engine rejects it.
  Cable delay and loss patterns are set from the CLI (`delay`, `loss pattern`) and round-trip in the running-config (#175).

### Engine: routing and services

- Routers, clients and servers (ARP, ICMP, static routes) frame for frame against Linux.
- DHCP against dnsmasq and udhcpc (#17); DHCP relay (#38).
- TCP against Linux sockets: handshake, data, close (#30); segments and data retransmission over a lossy hop (#133).
- HTTP GET (HTTP/1.0 server and client) over the engine's TCP (#168).
- Syslog: a UDP 514 receiver and a `syslog` action, against util-linux `logger` (#173).
- IPv4 access lists against nftables (#74). NAT (overload, static 1:1, port forwarding) against nftables, with the translation table compared to conntrack (#79, #83).
- RIPv2 against FRRouting ripd (#70).
- OSPFv2 against FRRouting ospfd: point-to-point and broadcast, DR election, passive interfaces, timers (#59, #71, #75, #77); several areas with ABRs, type 3 summary LSAs and inter-area routes (#90).
- IPv6 basics against Linux: global addresses, neighbor discovery, ICMPv6 echo, static routes (#155).

### Spec format

- Spec format v1 with a JSON Schema and a checker (#3, #21, #26, #28).
- YAML input for specs and actions, using the same schema (#93).

### Device CLI (`cli/`, `opr-cli`)

- Our own device CLI: modes, `?` and Tab help, `| json` on show commands, an OpenConfig-shaped model and a running-config round trip (#46, #84).
- Commands for VLANs, inter-VLAN routing, LLDP, RIP, OSPF (including areas), NAT, ACLs, port security, storm control, DHCP snooping, SPAN, HTTP pages, IPv6 and MAC aging (#62, #64, #65, #68, #109, #114, #116, #152, and the feature PRs above).
- Backends: engine, Linux (devices configured only by the CLI match the engine frame for frame, #56), FRR (rendered `frr.conf` runs in real ospfd/ripd, #68, #134) and OpenWrt (rendered UCI applied by real `uci` in the OpenWrt rootfs container, #156).
- Generated CLI reference with a freshness check (#54).
- Every node key of the spec format has a CLI command, checked by a test over a fixture that uses each key (#175).

### Studio (browser)

- Map, playback, panels, storm badge and cable cut (#35); consoles that use the real CLI, in tabs (#50, #125).
- Topology editor with palette, cable and delete tools, and edits checked by the spec validator (#89).
- Save and reopen as JSON or YAML, with autosave (#105, #121).
- Protocol panels for RIP/OSPF, NAT, ACL hits, LLDP, LACP and MAC aging (#98); playback filters and an event list (#131).
- Keyboard access, labels, reduced motion and a phone-width layout (#139).
- IPv6 panels and filters, DHCP snooping ports and drops, lossy cables, HTTP request lines and OSPF areas (#177).

### Labs and docs

- Example lab networks in `examples/`, each with actions, `commands.txt` and a student guide, plus a test that runs every guide's console commands (#31, #34, #101).
- README quick start (#142); validation on a Mac via Docker (#2); mismatches reported as GitHub annotations (#40).
- Licensed under Apache-2.0 (#42).
