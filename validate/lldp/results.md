| Network | Snapshot | Engine neighbor tables (same in lldpd?) | Checks | Match |
|---|---|---|---|---|
| lldp-direct | converged: three nodes, two cables | R1: eth0=R2; R2: eth0=R1, eth1=H3; H3: eth0=R2 | neighbor tables ✓, LLDPDU contents ✓, LLDPDUs per cable (within 1) ✓ · LLDPDUs 12 (Linux 8) | ✓ |
| lldp-direct | R1-R2 cut | R1: none; R2: eth1=H3; H3: eth0=R2 | neighbor tables ✓, LLDPDU contents ✓, LLDPDUs per cable (within 1) ✓ · LLDPDUs 0 (Linux 0) | ✓ |
| lldp-direct | R1-R2 restored | R1: eth0=R2; R2: eth0=R1, eth1=H3; H3: eth0=R2 | neighbor tables ✓, LLDPDU contents ✓, LLDPDUs per cable (within 1) ✓ · LLDPDUs 8 (Linux 8) | ✓ |
| lldp-switch | converged: R1 and R2 see each other across SW1, R4 and R5 see nothing | R1: eth0=R2; R2: eth0=R1; R4: none; R5: none | neighbor tables ✓, LLDPDU contents ✓, LLDPDUs per cable (within 1) ✓ · LLDPDUs 18 (Linux 12) | ✓ |
| lldp-switch | R2 cut, R1 still holds R2 (within TTL) | R1: eth0=R2; R2: none; R4: none; R5: none | neighbor tables ✓, LLDPDU contents ✓, LLDPDUs per cable (within 1) ✓ · LLDPDUs 0 (Linux 0) | ✓ |
| lldp-switch | R1 has aged R2 out | R1: none; R2: none; R4: none; R5: none | neighbor tables ✓, LLDPDU contents ✓, LLDPDUs per cable (within 1) ✓ · LLDPDUs 6 (Linux 6) | ✓ |
| lldp-switch | R2 restored, R1 learned it again | R1: eth0=R2; R2: none; R4: none; R5: none | neighbor tables ✓, LLDPDU contents ✓, LLDPDUs per cable (within 1) ✓ · LLDPDUs 2 (Linux 2) | ✓ |
