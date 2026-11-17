| Network | Action | Engine result (same in Linux?) | Frames (engine = Linux, cable by cable?) | Match |
|---|---|---|---|---|
| fti-routed | ping ZFW-VOICE → 10.1.0.1 | ok from 10.1.0.1 | 9 frames on 5 cable directions | ✓ |
| fti-routed | ping ZFW-VOICE → 10.1.0.11 | ok from 10.1.0.11 | 9 frames on 5 cable directions | ✓ |
| fti-routed | ping ZFW-VOICE → 172.16.20.10 | ok from 172.16.20.10 | 29 frames on 15 cable directions | ✓ |
| fti-routed | ping ELD-RADIO → 10.0.0.5 | ok from 10.0.0.5 | 25 frames on 13 cable directions | ✓ |
| fti-routed | traceroute ZFW-VOICE → 172.16.20.10 | reached · 10.1.0.1 → 10.255.1.1 → 10.255.2.2 → 10.255.3.2 → 172.16.20.10 | 57 frames on 15 cable directions | ✓ |
| fti-routed | dns ZME-VOICE → 10.0.0.53 (eld-radio.fti) | ok from 10.0.0.53 · answer 172.16.20.10 | 21 frames on 11 cable directions | ✓ |
| fti-routed | udp ZME-VOICE → 172.16.20.10 port 9999 | port unreachable from 172.16.20.10 | 20 frames on 10 cable directions | ✓ |
| fti-routed | ping ZFW-VOICE → 10.2.0.99 | host unreachable from 10.255.2.2 | 23 frames on 11 cable directions | ✓ |
| fti-loop | ping ZFW-VOICE → 172.16.20.10 | time exceeded from 10.255.1.1 | 77 frames on 9 cable directions | ✓ |
| fti-loop | traceroute ZFW-VOICE → 172.16.20.10 | not reached · 10.1.0.1 → 10.255.1.1 → 10.255.2.2 → 10.255.1.1 → 10.255.2.2 → 10.255.1.1 | 55 frames on 9 cable directions | ✓ |
| fti-noreturn | ping ZFW-VOICE → 172.16.20.10 | timeout | 26 frames on 15 cable directions | ✓ |
| fti-noreturn | traceroute ZFW-VOICE → 172.16.20.10 | not reached · 10.1.0.1 → 10.255.1.1 → 10.255.2.2 → * → * | 49 frames on 15 cable directions | ✓ |
