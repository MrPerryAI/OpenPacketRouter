| Scenario | Verdict | Math predicts | Linux kernel bridges did | Match |
|---|---|---|---|---|
| 1-baseline | TREE | 11 copies | 11 copies, each host once: yes | ✓ |
| 5-hardened | TREE | 12 copies | 12 copies, each host once: yes | ✓ |
| 4a-xconAB-core-sees | CIRCULATING | 458 frames/s on busiest cable | 473 frames/s; worst cable off by 3.7% (15 cables) | ✓ |
| 6-routed-rebreak | CIRCULATING | 458 frames/s on busiest cable | 473 frames/s; worst cable off by 3.7% (6 cables) | ✓ |
| 4b-xconAB-core-blind | AMPLIFYING | doubles every 5.9 ms (long run); simulator 5.5 ms in the same window | doubles every 5.5 ms in 18–45 ms (7% vs math, 0% vs simulator) | ✓ |
| 7-core-stp-off | AMPLIFYING | doubles every 10.7 ms (long run); simulator 10.2 ms in the same window | doubles every 10.2 ms in 17–77 ms (5% vs math, 0% vs simulator) | ✓ |

Measured overhead per switch hop (kernel bridge + relay): 0.182 ms, added to the model.
