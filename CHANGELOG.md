# Changelog

All notable changes to OpenPacketRouter. Every feature listed under "Validated" is compared frame for frame against
real Linux (kernel, FRRouting, dnsmasq, keepalived, …) in CI; see `validate/` and `docs/STATUS.md`.

Versions are not tagged or published yet: the owner decides when v1.0 is released.

## Unreleased (v1.0 candidate)

### Engine: switching (validated vs Linux bridges and tools)

- Spanning tree with real BPDUs, VLANs and trunks (#11); tie-breaks on parallel cables and equal-cost paths (#15).
- Topology change notices: TCN BPDUs, the TC flag and fast MAC aging (#69, validator plateaus #86). The 1 s hold timer is
  rounded to whole jiffies seconds as the kernel's `round_jiffies` does; the validator measures the kernel's jiffies phase
  and runs on that schedule (#188, #217, #228).
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
- Link capacity, queues and drops against `tbf` (#13). Shaped cables also carry spanning-tree, LACP, LLDP and IPv6 frames, sized as Linux sizes them (#184).
- Link delay and deterministic loss against `tc netem` (#135). Random loss can't be matched frame for frame, so the engine rejects it.
  Cable delay and loss patterns are set from the CLI (`delay`, `loss pattern`) and round-trip in the running-config (#175).

### Engine: routing and services

- Routers, clients and servers (ARP, ICMP, static routes) frame for frame against Linux.
- DHCP against dnsmasq and udhcpc (#17); DHCP relay (#38).
- TCP against Linux sockets: handshake, data, close (#30); segments and data retransmission over a lossy hop (#133); the receive window: a full receiver stalls the sender, which probes until a window update (#176).
- HTTP GET (HTTP/1.0 server and client) over the engine's TCP (#168).
- Syslog: a UDP 514 receiver and a `syslog` action, against util-linux `logger` (#173).
- NTP: a UDP 123 server (`service ntp STRATUM`, `show ntp`) and an `ntp` query action, against the real `ntpdate` client; NTP timestamps (wall clock vs simulated time) are not compared (#185).
- IPv4 access lists against nftables (#74). NAT (overload, static 1:1, port forwarding) against nftables, with the translation table compared to conntrack (#79, #83).
- RIPv2 against FRRouting ripd (#70).
- OSPFv2 against FRRouting ospfd: point-to-point and broadcast, DR election, passive interfaces, timers (#59, #71, #75, #77); several areas with ABRs, type 3 summary LSAs and inter-area routes (#90). Flushed (MaxAge) LSAs leave on one shared
  remover timer as in ospfd, which fixed an intermittent mismatch when a router returns (#213).
  Redistribution: an ASBR announces static and connected routes as type 5 externals (E1 and E2), with type 4 ASBR summaries
  across areas (#230).
- VRRP v2 first-hop redundancy on routers against keepalived: master election, preemption on and off, takeover when the master fails, ping to the virtual address, advertisements counted exactly on every cable; CLI `vrrp` commands and `show vrrp` (#180). A Linux-only race reply (the old master answering the new master's gratuitous ARP) is left out and counted in the results (#216).
- IPv6 basics against Linux: global addresses, neighbor discovery, ICMPv6 echo, static routes (#155).
- RIPng (IPv6 RIP) on routers against FRRouting ripngd: routing tables, the last update and newly poisoned routes on every cable, requests, split horizon and timers; CLI `ipv6 ripng` commands (#198).

### Spec format

- Spec format v1 with a JSON Schema and a checker (#3, #21, #26, #28).
- YAML input for specs and actions, using the same schema (#93).

### Device CLI (`cli/`, `opr-cli`)

- Our own device CLI: modes, `?` and Tab help, `| json` on show commands, an OpenConfig-shaped model and a running-config round trip (#46, #84).
- Commands for VLANs, inter-VLAN routing, LLDP, RIP, OSPF (including areas), VRRP, NAT, ACLs, port security, storm control, DHCP snooping, SPAN, HTTP pages, IPv6 and MAC aging (#62, #64, #65, #68, #109, #114, #116, #152, and the feature PRs above).
- Backends: engine, Linux (devices configured only by the CLI match the engine frame for frame, #56), FRR (rendered `frr.conf` runs in real ospfd/ripd/ripngd, #68, #134, #225) and OpenWrt (rendered UCI applied by real `uci` in the OpenWrt rootfs container, #156).
- Generated CLI reference with a freshness check (#54).
- The engine's `--text` report has a plain line for every action, including VRRP state and LLDP neighbours (#206).
- Every node key of the spec format has a CLI command, checked by a test over a fixture that uses each key (#175).
- `show ipv6 route`, `show ipv6 neighbors` and `show ipv6 ripng`, each with `| json` (#212).

### Studio (browser)

- Map, playback, panels, storm badge and cable cut (#35); consoles that use the real CLI, in tabs (#50, #125).
- Topology editor with palette, cable and delete tools, and edits checked by the spec validator (#89).
- Save and reopen as JSON or YAML, with autosave (#105, #121).
- Protocol panels for RIP/OSPF, NAT, ACL hits, LLDP, LACP and MAC aging (#98); playback filters and an event list (#131).
- Keyboard access, labels, reduced motion and a phone-width layout (#139).
- IPv6 panels and filters, DHCP snooping ports and drops, lossy cables, HTTP request lines and OSPF areas (#177).
- A Services section in the device panel: stored syslog messages and the NTP server's stratum and answered queries (#189).
- A VRRP table in the device panel and VRRP frames in playback and filters (#205).
- The Studio smoke test plays every example lab and checks that every frame is described, has a filter, and that every device panel opens (#210).
- Opening an example lab shows its student guide beside the map, with buttons that run the guide's commands in the right device console (#221).

### Labs and docs

- Example lab networks in `examples/`, each with actions, `commands.txt` and a student guide, plus a test that runs every guide's console commands (#31, #34, #101).
- New labs with student guides: a VRRP gateway pair and a services lab (syslog, NTP) (#203).
- README quick start (#142); validation on a Mac via Docker (#2); mismatches reported as GitHub annotations (#40).
- A release check in CI runs the README quick start commands and checks the npm package contents, without publishing (#218).
- Licensed under Apache-2.0 (#42).
