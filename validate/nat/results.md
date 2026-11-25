| Network | Action | Engine result (same in Linux?) | Frames (engine = Linux, cable by cable?) and translation table | Match |
|---|---|---|---|---|
| nat-lab | ping B → 203.0.113.50 | ok from 203.0.113.50 | 14 frames on 8 cable directions; 1 new tracked flow | ✓ |
| nat-lab | ping A → 203.0.113.50 | ok from 203.0.113.50 | 14 frames on 8 cable directions; 1 new tracked flow | ✓ |
| nat-lab | ping S → 203.0.113.10 | ok from 203.0.113.10 | 14 frames on 8 cable directions; 1 new tracked flow | ✓ |
| nat-lab | ping S → 203.0.113.1 | ok from 203.0.113.1 | 4 frames on 2 cable directions; 0 new tracked flows | ✓ |
| nat-lab | tcp B → 203.0.113.50 port 80 | ok from 203.0.113.50 | 38 frames on 8 cable directions; 1 new tracked flow | ✓ |
| nat-lab | tcp W → 203.0.113.50 port 80 | ok from 203.0.113.50 | 38 frames on 8 cable directions; 1 new tracked flow | ✓ |
| nat-lab | tcp S → 203.0.113.10 port 7 | ok from 203.0.113.10 | 38 frames on 8 cable directions; 1 new tracked flow | ✓ |
| nat-lab | tcp S → 203.0.113.1 port 8080 | ok from 203.0.113.1 | 38 frames on 8 cable directions; 1 new tracked flow | ✓ |
| nat-lab | tcp B → 203.0.113.50 port 81 | refused from 203.0.113.50 | 14 frames on 8 cable directions; 0 new tracked flows | ✓ |
| nat-lab | udp B → 203.0.113.50 port 9999 | port unreachable from 203.0.113.50 | 14 frames on 8 cable directions; 1 new tracked flow | ✓ |
| nat-lab | dns B → 203.0.113.50 (srv.lab) | ok from 203.0.113.50 | 14 frames on 8 cable directions; 1 new tracked flow | ✓ |
| nat-lab | traceroute B → 203.0.113.50 | reached · 10.1.0.1 → 203.0.113.50 | 18 frames on 8 cable directions; 1 new tracked flow | ✓ |
