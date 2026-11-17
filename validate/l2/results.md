| Network | t | Action | Engine result (same in Linux?) | Compared | Match |
|---|---|---|---|---|---|
| stp-triangle | 0.5s | ping PC-A → 10.0.0.2 | timeout | 3 frames on 1 cable directions | ✓ |
| stp-triangle | 4.6s | ping PC-A → 10.0.0.2 | timeout | 3 frames on 1 cable directions | ✓ |
| stp-triangle | 12s | spanning-tree state | root 1000.020000000003; blocked: SW-B:g2 | 9 ports compared | ✓ |
| stp-triangle | 12.5s | ping PC-A → 10.0.0.2 | ok from 10.0.0.2 | 18 frames on 10 cable directions | ✓ |
| stp-triangle | 14s | ping PC-B → 10.0.0.3 | ok from 10.0.0.3 | 15 frames on 9 cable directions | ✓ |
| stp-triangle | 24s | watch BPDUs for 8s | BPDUs on 6 cable directions | 24 BPDUs (count ±1), last one compared field by field | ✓ |
| stp-triangle | 33s | unplug SW-CORE:g2 | — | — | ✓ |
| stp-triangle | 34s | spanning-tree state | root 1000.020000000003; blocked: none; SW-B:g2 listening | 9 ports compared | ✓ |
| stp-triangle | 35s | ping PC-B → 10.0.0.3 | timeout | 3 frames on 1 cable directions | ✓ |
| stp-triangle | 43s | ping PC-B → 10.0.0.3 | ok from 10.0.0.3 | 17 frames on 9 cable directions | ✓ |
| stp-triangle | 47s | spanning-tree state | root 1000.020000000003; blocked: none | 9 ports compared | ✓ |
| stp-ring | 12s | spanning-tree state | root 1000.020000000004; blocked: SW4:t1, SW4:up | 13 ports compared | ✓ |
| stp-ring | 12.5s | ping PC2 → 10.0.0.4 | ok from 10.0.0.4 | 25 frames on 15 cable directions | ✓ |
| stp-ring | 14s | ping PC-HUB → 10.0.0.1 | ok from 10.0.0.1 | 22 frames on 14 cable directions | ✓ |
| stp-ring | 24s | watch BPDUs for 8s | BPDUs on 10 cable directions | 40 BPDUs (count ±1), last one compared field by field | ✓ |
| stp-ring | 33s | unplug SW1:right | — | — | ✓ |
| stp-ring | 33.5s | ping PC2 → 10.0.0.1 | timeout | 21 frames on 7 cable directions | ✓ |
| stp-ring | 44s | spanning-tree state | root 1000.020000000004; blocked: SW3:t2; SW4:t1 learning, SW4:up learning | 13 ports compared | ✓ |
| stp-ring | 49s | ping PC2 → 10.0.0.1 | ok from 10.0.0.1 | 27 frames on 15 cable directions | ✓ |
| stp-ring | 53s | spanning-tree state | root 1000.020000000004; blocked: SW3:t2 | 13 ports compared | ✓ |
| vlan-trunk |  | ping STAFF-1 → 10.10.0.12 | ok from 10.10.0.12 | 13 frames on 7 cable directions, 5 tagged | ✓ |
| vlan-trunk |  | ping STUDENT-2 → 10.20.0.1 | ok from 10.20.0.1 | 14 frames on 8 cable directions, 8 tagged | ✓ |
| vlan-trunk |  | ping STAFF-2 → 10.20.0.21 | ok from 10.20.0.21 | 24 frames on 11 cable directions, 13 tagged | ✓ |
| vlan-trunk |  | traceroute STUDENT-1 → 10.10.0.12 | reached · 10.20.0.1 → 10.10.0.12 | 28 frames on 11 cable directions, 15 tagged | ✓ |
| vlan-trunk |  | ping PC-WRONG → 10.10.0.1 | timeout | 15 frames on 5 cable directions, 6 tagged | ✓ |
| vlan-native-mismatch |  | ping PC-A → 10.0.0.2 | ok from 10.0.0.2 | 12 frames on 6 cable directions | ✓ |
| vlan-native-mismatch |  | ping PC-A → 10.0.0.3 | timeout | 9 frames on 3 cable directions | ✓ |
| vlan-native-mismatch |  | ping PC-D → 10.0.10.2 | ok from 10.0.10.2 | 12 frames on 6 cable directions, 4 tagged | ✓ |
| vlan-stp | 12s | spanning-tree state | root 1000.020000000001; blocked: SW3:to2 | 12 ports compared | ✓ |
| vlan-stp | 12.5s | ping STAFF-2 → 10.10.0.13 | ok from 10.10.0.13 | 19 frames on 11 cable directions, 10 tagged | ✓ |
| vlan-stp | 14s | ping STUDENT-3 → 10.10.0.12 | ok from 10.10.0.12 | 31 frames on 14 cable directions, 20 tagged | ✓ |
| vlan-stp | 24s | watch BPDUs for 4s | BPDUs on 9 cable directions | 18 BPDUs (count ±1), last one compared field by field | ✓ |
