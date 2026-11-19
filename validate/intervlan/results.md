| Network | Action | Engine result (same in Linux?) | Frames (engine = Linux, cable by cable?) | Match |
|---|---|---|---|---|
| roas | ping A → 10.0.20.12 | ok from 10.0.20.12 | 20 frames on 9 cable directions | ✓ |
| roas | ping A → 10.0.20.22 | ok from 10.0.20.22 | 23 frames on 10 cable directions | ✓ |
| roas | ping A → 10.0.10.21 | ok from 10.0.10.21 | 13 frames on 7 cable directions | ✓ |
| roas | ping N → 10.0.20.22 | ok from 10.0.20.22 | 21 frames on 9 cable directions | ✓ |
| roas | ping A → 10.0.20.1 | ok from 10.0.20.1 | 10 frames on 6 cable directions | ✓ |
| roas | traceroute C → 10.0.20.12 | reached · 10.0.10.1 → 10.0.20.12 | 29 frames on 10 cable directions | ✓ |
| roas | ping A → 10.0.30.23 | net unreachable from 10.0.10.1 | 10 frames on 6 cable directions | ✓ |
| roas | ping A → 10.0.20.99 | host unreachable from 10.0.10.1 | 22 frames on 8 cable directions | ✓ |
| roas | ping E → 10.0.10.11 | timeout | 6 frames on 2 cable directions | ✓ |
| svi | ping A → 10.0.20.12 | ok from 10.0.20.12 | 12 frames on 7 cable directions | ✓ |
| svi | ping A → 10.0.20.22 | ok from 10.0.20.22 | 15 frames on 8 cable directions | ✓ |
| svi | ping C → 10.0.20.22 | ok from 10.0.20.22 | 18 frames on 8 cable directions | ✓ |
| svi | ping A → 10.0.10.21 | ok from 10.0.10.21 | 12 frames on 6 cable directions | ✓ |
| svi | ping D → 10.9.0.10 | ok from 10.9.0.10 | 17 frames on 9 cable directions | ✓ |
| svi | traceroute C → 10.9.0.10 | reached · 10.0.10.1 → 10.0.30.2 → 10.9.0.10 | 27 frames on 9 cable directions | ✓ |
| svi | ping SW1 → 10.9.0.10 | ok from 10.9.0.10 | 8 frames on 4 cable directions | ✓ |
| svi | ping B → 10.0.10.1 | ok from 10.0.10.1 | 6 frames on 4 cable directions | ✓ |
| svi | ping A → 10.0.20.99 | host unreachable from 10.0.10.1 | 15 frames on 6 cable directions | ✓ |
| svi | ping A → 10.8.0.1 | net unreachable from 10.0.10.1 | 6 frames on 4 cable directions | ✓ |
