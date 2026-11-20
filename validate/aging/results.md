| Network | Step | Result | Match |
|---|---|---|---|
| aging | 1. ping A → 10.0.0.3 | ok · 13 frames on 7 cable directions | ✓ |
| aging | 2. MAC tables SW1, SW2 | SW1: 2 entries · SW2: 2 entries | ✓ |
| aging | 3. ping C → 10.0.0.1 | ok · 6 frames on 6 cable directions | ✓ |
| aging | 4. MAC tables SW1, SW2 | SW1: 0 entries · SW2: 2 entries | ✓ |
| aging | 5. ping A → 10.0.0.3 | ok · 7 frames on 7 cable directions | ✓ |
| aging | 6. MAC tables SW1, SW2 | SW1: 2 entries · SW2: 2 entries | ✓ |
