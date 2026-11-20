Each device configured only by `opr-cli SPEC DEVICE --render linux --lab-parity` (1159 commands across 59 devices); cabling from the spec. The rendered DNS names are served by validate/l3's stand-in server, because the engine's DNS is a simplified protocol.

| Network | Action | Frames (engine = Linux, cable by cable?) | Match |
|---|---|---|---|
| fti-routed | ping ZFW-VOICE → 10.1.0.1 | 9 frames on 5 cable directions | ✓ |
| fti-routed | ping ZFW-VOICE → 10.1.0.11 | 9 frames on 5 cable directions | ✓ |
| fti-routed | ping ZFW-VOICE → 172.16.20.10 | 29 frames on 15 cable directions | ✓ |
| fti-routed | ping ELD-RADIO → 10.0.0.5 | 25 frames on 13 cable directions | ✓ |
| fti-routed | traceroute ZFW-VOICE → 172.16.20.10 | 57 frames on 15 cable directions | ✓ |
| fti-routed | dns ZME-VOICE → 10.0.0.53 (eld-radio.fti) | 21 frames on 11 cable directions | ✓ |
| fti-routed | udp ZME-VOICE → 172.16.20.10 | 20 frames on 10 cable directions | ✓ |
| fti-routed | ping ZFW-VOICE → 10.2.0.99 | 23 frames on 11 cable directions | ✓ |
| fti-loop | ping ZFW-VOICE → 172.16.20.10 | 77 frames on 9 cable directions | ✓ |
| fti-loop | traceroute ZFW-VOICE → 172.16.20.10 | 55 frames on 9 cable directions | ✓ |
| fti-noreturn | ping ZFW-VOICE → 172.16.20.10 | 26 frames on 15 cable directions | ✓ |
| fti-noreturn | traceroute ZFW-VOICE → 172.16.20.10 | 49 frames on 15 cable directions | ✓ |
| roas | ping A → 10.0.20.12 | 20 frames on 9 cable directions | ✓ |
| roas | ping A → 10.0.20.22 | 23 frames on 10 cable directions | ✓ |
| roas | ping A → 10.0.10.21 | 13 frames on 7 cable directions | ✓ |
| roas | ping N → 10.0.20.22 | 21 frames on 9 cable directions | ✓ |
| roas | ping A → 10.0.20.1 | 10 frames on 6 cable directions | ✓ |
| roas | traceroute C → 10.0.20.12 | 29 frames on 10 cable directions | ✓ |
| roas | ping A → 10.0.30.23 | 10 frames on 6 cable directions | ✓ |
| roas | ping A → 10.0.20.99 | 22 frames on 8 cable directions | ✓ |
| roas | ping E → 10.0.10.11 | 6 frames on 2 cable directions | ✓ |
| svi | ping A → 10.0.20.12 | 12 frames on 7 cable directions | ✓ |
| svi | ping A → 10.0.20.22 | 15 frames on 8 cable directions | ✓ |
| svi | ping C → 10.0.20.22 | 18 frames on 8 cable directions | ✓ |
| svi | ping A → 10.0.10.21 | 12 frames on 6 cable directions | ✓ |
| svi | ping D → 10.9.0.10 | 17 frames on 9 cable directions | ✓ |
| svi | traceroute C → 10.9.0.10 | 27 frames on 9 cable directions | ✓ |
| svi | ping SW1 → 10.9.0.10 | 8 frames on 4 cable directions | ✓ |
| svi | ping B → 10.0.10.1 | 6 frames on 4 cable directions | ✓ |
| svi | ping A → 10.0.20.99 | 15 frames on 6 cable directions | ✓ |
| svi | ping A → 10.8.0.1 | 6 frames on 4 cable directions | ✓ |

Example: what the CLI rendered for one router of fti-routed.

```
sysctl -w net.ipv6.conf.all.disable_ipv6=1
sysctl -w net.ipv6.conf.default.disable_ipv6=1
sysctl -w net.ipv4.conf.all.send_redirects=0
sysctl -w net.ipv4.conf.default.send_redirects=0
sysctl -w net.ipv4.icmp_ratelimit=0
sysctl -w net.ipv4.conf.all.rp_filter=0
sysctl -w net.ipv4.conf.default.rp_filter=0
sysctl -w net.ipv6.conf.to-zfw.disable_ipv6=1
sysctl -w net.ipv4.conf.to-zfw.send_redirects=0
sysctl -w net.ipv4.conf.to-zfw.rp_filter=0
sysctl -w net.ipv6.conf.to-zme.disable_ipv6=1
sysctl -w net.ipv4.conf.to-zme.send_redirects=0
sysctl -w net.ipv4.conf.to-zme.rp_filter=0
sysctl -w net.ipv6.conf.lan.disable_ipv6=1
sysctl -w net.ipv4.conf.lan.send_redirects=0
sysctl -w net.ipv4.conf.lan.rp_filter=0
sysctl -w net.ipv4.ip_forward=1
ip addr add 10.255.1.1/30 dev to-zfw
ip link set to-zfw up
ip addr add 10.255.2.1/30 dev to-zme
ip link set to-zme up
ip addr add 10.0.0.1/24 dev lan
ip link set lan up
ip route add 10.1.0.0/24 via 10.255.1.2
ip route add 10.2.0.0/24 via 10.255.2.2
ip route add 172.16.20.0/24 via 10.255.2.2
ip route add 10.255.3.0/30 via 10.255.2.2
```
