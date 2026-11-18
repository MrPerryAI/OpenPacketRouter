| Network | Check | Result | Match |
|---|---|---|---|
| vlan-trunk | ping A → 10.0.0.3 | ok · 12 frames on 6 cable directions | ✓ |
| vlan-trunk | ping B → 10.0.0.4 | ok · 12 frames on 6 cable directions | ✓ |
| vlan-trunk | ping A → 10.0.0.2 | no reply · 9 frames on 3 cable directions | ✓ |
| vlan-trunk | ping E → 10.0.0.6 | no reply · 3 frames on 1 cable directions | ✓ |
| vlan-native | ping A → 10.0.0.3 | ok · 12 frames on 6 cable directions | ✓ |
| vlan-native | ping B → 10.0.0.4 | ok · 12 frames on 6 cable directions | ✓ |
| vlan-native | ping A → 10.0.0.2 | no reply · 9 frames on 3 cable directions | ✓ |
| stp-ring | converged | roles, states, costs | ✓ |
| stp-ring | ping A → 10.0.0.2 | reachable | ✓ |
| stp-ring | SW1-SW2 cut | roles, states, costs | ✓ |
| stp-ring | ping A → 10.0.0.2 | reachable | ✓ |
| stp-ring | restored | roles, states, costs | ✓ |
| stp-tiebreak | converged | roles, states, costs | ✓ |
| stp-tiebreak | ping A → 10.0.0.2 | reachable | ✓ |
| stp-tiebreak | first cable cut | roles, states, costs | ✓ |
| stp-tiebreak | ping A → 10.0.0.2 | reachable | ✓ |
| stp-tiebreak | both cables cut | roles, states, costs | ✓ |
| stp-tiebreak | ping A → 10.0.0.2 | reachable | ✓ |
