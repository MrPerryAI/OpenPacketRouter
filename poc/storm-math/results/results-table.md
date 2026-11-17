| Scenario | ρ | Verdict | Hosts flooded | Math vs simulator |
|---|---|---|---|---|
| **1-baseline** — Part 1: healthy network, STP converged | 0.000 | TREE | none | copies of one broadcast: math 11, simulator 11 |
| **2-fiber** — Part 2 step 2: new fiber connected, no cross-connects | 0.000 | TREE | none | copies of one broadcast: math 12, simulator 12 |
| **3a-xconA-core-sees** — Step 4, cross-connect A; core STP sees the big loop (real Cisco: BPDUs pass through) - ZME Fa0/4 blocks (ASSUMED) | 0.000 | TREE | none | copies of one broadcast: math 12, simulator 12 |
| **3b-xconA-core-blind** — Step 4, cross-connect A; core STP can't see the loop (BPDUs dropped at El Dorado) | 1.000 | CIRCULATING | AMA-RADAR, ELD-RADIO, NOC-MON, ZAB-VOICE, ZFW-VOICE, ZME-VOICE | broadcasts/s hitting NOC-MON after ONE broadcast: math 125, simulator 127 |
| **4a-xconAB-core-sees** — Step 5, both cross-connects; core blocks the big loop, the El Dorado pair loops on its own | 1.000 | CIRCULATING | AMA-RADAR, ELD-RADIO, NOC-MON, ZAB-VOICE, ZFW-VOICE, ZME-VOICE | broadcasts/s hitting NOC-MON after ONE broadcast: math 78,616, simulator 78,613 |
| **4b-xconAB-core-blind** — Step 5, both cross-connects; core can't see either loop | 1.544 | AMPLIFYING | AMA-RADAR, ELD-RADIO, NOC-MON, ZAB-VOICE, ZFW-VOICE, ZME-VOICE | frames double every: math 1.84 ms, simulator 1.84 ms |
| **5-hardened** — Part 3: STP back on at El Dorado - one cross-connect and one uplink block (ASSUMED ELD-OLD Fa0/24, ZME Fa0/4) | 0.000 | TREE | none | copies of one broadcast: math 12, simulator 12 |
| **6-routed-rebreak** — Part 4: routed edge, then the original mistake re-made inside El Dorado | 1.000 | CIRCULATING | ELD-RADIO | broadcasts/s hitting ELD-RADIO after ONE broadcast: math 78,616, simulator 78,620 |
| **7-core-stp-off** — What-if: spanning tree off on the core ring itself | 1.521 | AMPLIFYING | AMA-RADAR, ELD-RADIO, NOC-MON, ZAB-VOICE, ZFW-VOICE, ZME-VOICE | frames double every: math 10.44 ms, simulator 10.44 ms |
