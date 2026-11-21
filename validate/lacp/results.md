| Network | Step | Result | Match |
|---|---|---|---|
| lacp | 1. LACP SW1, SW2 | SW1/Po1: p3=61,p4=61,p5=61 · SW2/Po1: p3=63,p4=63,p5=63 | ✓ |
| lacp | 2. BPDU kinds per cable direction | 3 cable directions with BPDUs | ✓ |
| lacp | 3. BPDU kinds per cable direction | 6 cable directions with BPDUs | ✓ |
| lacp | 4. ping A → 10.0.0.2 | ok · 14 frames on 9 cable directions | ✓ |
| lacp | 5. ping C → 10.0.0.2 | ok · 14 frames on 9 cable directions | ✓ |
| lacp | 6. ping A → 10.0.0.4 | ok · 14 frames on 9 cable directions | ✓ |
| lacp | 7. ping C → 10.0.0.4 | ok · 14 frames on 9 cable directions | ✓ |
| lacp | 8. ping B → 10.0.0.3 | ok · 6 frames on 6 cable directions | ✓ |
| lacp | 9. MAC tables SW1, SW2 | SW1: 4 entries · SW2: 4 entries | ✓ |
| lacp | 10. LACP SW1, SW2 | SW1/Po1: p3=None,p4=61,p5=61 · SW2/Po1: p3=None,p4=63,p5=63 | ✓ |
| lacp | 11. ping A → 10.0.0.2 | ok · 14 frames on 8 cable directions | ✓ |
| lacp | 12. ping C → 10.0.0.4 | ok · 14 frames on 9 cable directions | ✓ |
| lacp | 13. ping D → 10.0.0.1 | ok · 14 frames on 8 cable directions | ✓ |
| lacp | 14. LACP SW1, SW2 | SW1/Po1: p3=61,p4=61,p5=61 · SW2/Po1: p3=63,p4=63,p5=63 | ✓ |
| lacp | 15. ping A → 10.0.0.2 | ok · 14 frames on 9 cable directions | ✓ |
| lacp | 16. ping C → 10.0.0.4 | ok · 14 frames on 9 cable directions | ✓ |
| lacp | 17. ping D → 10.0.0.1 | ok · 14 frames on 10 cable directions | ✓ |
