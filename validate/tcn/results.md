| Network | Step | Result | Match |
|---|---|---|---|
| ring | 1. topology change SW1, SW2, SW3, SW4 | SW1: tc=1 aging=8s · SW2: tc=1 aging=8s · SW3: tc=1 aging=8s · SW4: tc=1 aging=8s | ✓ |
| ring | 2. topology change SW1, SW2, SW3, SW4 | SW1: tc=0 aging=20s · SW2: tc=0 aging=20s · SW3: tc=0 aging=20s · SW4: tc=0 aging=20s | ✓ |
| ring | 3. BPDU kinds per cable direction | 7 cable directions with BPDUs | ✓ |
| ring | 4. ping A → 10.0.0.2 | ok · 19 frames on 11 cable directions | ✓ |
| ring | 5. MAC tables SW1, SW2, SW3, SW4 | SW1: 2 entries · SW2: 1 entries · SW3: 2 entries · SW4: 2 entries | ✓ |
| ring | 6. topology change SW1, SW2, SW3, SW4 | SW1: tc=0 aging=20s · SW2: tc=1 aging=8s · SW3: tc=0 aging=20s · SW4: tc=0 aging=20s | ✓ |
| ring | 7. BPDU kinds per cable direction | 7 cable directions with BPDUs | ✓ |
| ring | 8. ping A → 10.0.0.2 | ok · 8 frames on 8 cable directions | ✓ |
| ring | 9. topology change SW1, SW2, SW3, SW4 | SW1: tc=1 aging=8s · SW2: tc=1 aging=8s · SW3: tc=1 aging=8s · SW4: tc=1 aging=8s | ✓ |
| ring | 10. MAC tables SW1, SW2, SW3, SW4 | SW1: 2 entries · SW2: 0 entries · SW3: 2 entries · SW4: 2 entries | ✓ |
| ring | 11. MAC tables SW1, SW2, SW3, SW4 | SW1: 0 entries · SW2: 0 entries · SW3: 0 entries · SW4: 0 entries | ✓ |
| ring | 12. topology change SW1, SW2, SW3, SW4 | SW1: tc=0 aging=20s · SW2: tc=0 aging=20s · SW3: tc=0 aging=20s · SW4: tc=0 aging=20s | ✓ |
| ring | 13. BPDU kinds per cable direction | 6 cable directions with BPDUs | ✓ |
| ring | 14. ping A → 10.0.0.2 | ok · 10 frames on 10 cable directions | ✓ |
| ring | 15. MAC tables SW1, SW2, SW3, SW4 | SW1: 2 entries · SW2: 1 entries · SW3: 2 entries · SW4: 2 entries | ✓ |
| ring | 16. BPDU kinds per cable direction | 6 cable directions with BPDUs | ✓ |
| ring | 17. BPDU kinds per cable direction | 5 cable directions with BPDUs | ✓ |
| ring | 18. topology change SW1, SW2, SW3, SW4 | SW1: tc=1 aging=8s · SW2: tc=1 aging=8s · SW3: tc=1 aging=8s · SW4: tc=1 aging=8s | ✓ |
| ring | 19. BPDU kinds per cable direction | 8 cable directions with BPDUs | ✓ |
| ring | 20. topology change SW1, SW2, SW3, SW4 | SW1: tc=0 aging=20s · SW2: tc=0 aging=20s · SW3: tc=0 aging=20s · SW4: tc=0 aging=20s | ✓ |
| ring | 21. BPDU kinds per cable direction | 6 cable directions with BPDUs | ✓ |
