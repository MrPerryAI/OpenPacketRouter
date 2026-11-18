| Network | Action | Engine result and client-side segments (same in Linux?) | Frames (engine = Linux, cable by cable?) | Match |
|---|---|---|---|---|
| tcp-lan | tcp C → 10.2.0.10:7 (100 bytes) | echo of 100 bytes · >S <SA >A >PA 100 <A <PA 100 >A >FA <FA >A | 49 frames on 9 cable directions | ✓ |
| tcp-lan | tcp C → 10.2.0.10:7 (1 bytes) | echo of 1 bytes · >S <SA >A >PA 1 <A <PA 1 >A >FA <FA >A | 49 frames on 9 cable directions | ✓ |
| tcp-lan | tcp C → 10.2.0.10:8 | refused · >S <RA | 17 frames on 9 cable directions | ✓ |
| tcp-lan | tcp C → 10.2.0.20:7 | timeout · >S >S >S | 21 frames on 9 cable directions | ✓ |
