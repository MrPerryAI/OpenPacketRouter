| Network | Action | Frames (engine = Linux, cable by cable?) | Queue drops (engine = Linux?) | Match |
|---|---|---|---|---|
| tbf-host | udpBurst A → 10.0.0.2 ×20 of 1000 B | 28 frames on 4 cable directions | A:eth0 14 | ✓ |
| tbf-host | udpBurst A → 10.0.0.2 ×3 of 1000 B | 16 frames on 4 cable directions | none | ✓ |
| tbf-host | udpBurst A → 10.0.0.2 ×40 of 200 B | 124 frames on 4 cable directions | A:eth0 10 | ✓ |
| tbf-host | ping A → 10.0.0.2 | 8 frames on 4 cable directions | none | ✓ |
| tbf-switch | udpBurst A → 10.0.0.2 ×25 of 1000 B | 44 frames on 4 cable directions | SW:p2 20 | ✓ |
| tbf-switch | udpBurst A → 10.0.0.2 ×6 of 500 B | 28 frames on 4 cable directions | none | ✓ |
