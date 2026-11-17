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
| stp-ring | 12s | spanning-tree state | root 1000.020000000004; blocked: SW4:t1, SW4:up | 13 ports compared | ✗ |
| stp-ring | 12.5s | ping PC2 → 10.0.0.4 | ok from 10.0.0.4 | 25 frames on 15 cable directions | ✓ |
| stp-ring | 14s | ping PC-HUB → 10.0.0.1 | ok from 10.0.0.1 | 22 frames on 14 cable directions | ✓ |
| stp-ring | 24s | watch BPDUs for 8s | BPDUs on 10 cable directions | 40 BPDUs (count ±1), last one compared field by field | ✗ |
| stp-ring | 33s | unplug SW1:right | — | — | ✓ |
| stp-ring | 33.5s | ping PC2 → 10.0.0.1 | timeout | 21 frames on 7 cable directions | ✓ |
| stp-ring | 44s | spanning-tree state | root 1000.020000000004; blocked: SW3:t2; SW4:t1 learning, SW4:up learning | 13 ports compared | ✓ |
| stp-ring | 49s | ping PC2 → 10.0.0.1 | ok from 10.0.0.1 | 27 frames on 15 cable directions | ✓ |
| stp-ring | 53s | spanning-tree state | root 1000.020000000004; blocked: SW3:t2 | 13 ports compared | ✓ |

Skipped (this kernel has no 802.1Q VLAN support): vlan-trunk, vlan-native-mismatch, vlan-stp.
