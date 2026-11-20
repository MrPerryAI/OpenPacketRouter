| Network | Step | Result | Match |
|---|---|---|---|
| ring | 1. topology change SW1, SW2, SW3, SW4 | SW1: tc=1 aging=8s · SW2: tc=1 aging=8s · SW3: tc=1 aging=8s · SW4: tc=1 aging=8s | ✓ |
| ring | 2. topology change SW1, SW2, SW3, SW4 | SW1: tc=0 aging=20s · SW2: tc=0 aging=20s · SW3: tc=0 aging=20s · SW4: tc=0 aging=20s | ✓ |
| ring | 3. ping A → 10.0.0.2 | ok | ✓ |
| ring | 4. MAC tables SW1, SW2, SW3, SW4 | SW1: 2 entries · SW2: 1 entries · SW3: 2 entries · SW4: 2 entries | ✓ |
| ring | 5. topology change SW1, SW2, SW3, SW4 | SW1: tc=0 aging=20s · SW2: tc=1 aging=8s · SW3: tc=0 aging=20s · SW4: tc=0 aging=20s | ✓ |
| ring | 6. ping A → 10.0.0.2 | ok | ✓ |
| ring | 7. topology change SW1, SW2, SW3, SW4 | SW1: tc=1 aging=8s · SW2: tc=1 aging=8s · SW3: tc=1 aging=8s · SW4: tc=1 aging=8s | ✓ |
| ring | 8. MAC tables SW1, SW2, SW3, SW4 | SW1: 2 entries · SW2: 0 entries · SW3: 2 entries · SW4: 2 entries | ✓ |
| ring | 9. MAC tables SW1, SW2, SW3, SW4 | SW1: 0 entries · SW2: 0 entries · SW3: 0 entries · SW4: 0 entries | ✓ |
| ring | 10. topology change SW1, SW2, SW3, SW4 | SW1: tc=0 aging=20s · SW2: tc=0 aging=20s · SW3: tc=0 aging=20s · SW4: tc=0 aging=20s | ✓ |
| ring | 11. ping A → 10.0.0.2 | ok | ✓ |
| ring | 12. MAC tables SW1, SW2, SW3, SW4 | SW1: 2 entries · SW2: 1 entries · SW3: 2 entries · SW4: 2 entries | ✓ |
