| Network | Snapshot | Engine neighbors (same in ospfd?) | Checks | Match |
|---|---|---|---|---|
| ospf-p2p | converged | R1: eth0: 2.2.2.2 Full/-, eth1: 3.3.3.3 Full/-; R2: eth0: 1.1.1.1 Full/-, eth1: 3.3.3.3 Full/-; R3: eth0: 1.1.1.1 Full/-, eth1: 2.2.2.2 Full/- | neighbors ✓, interfaces ✓, routes ✓, database ✓, last hello on every cable ✓, packet types on every cable ✓ · hellos 138 (Linux 134) | ✓ |
| ospf-p2p | R1-R2 cut: R1 uses the direct link | R1: eth1: 3.3.3.3 Full/-; R2: eth1: 3.3.3.3 Full/-; R3: eth0: 1.1.1.1 Full/-, eth1: 2.2.2.2 Full/- | neighbors ✓, interfaces ✓, routes ✓, database ✓, last hello on every cable ✓, packet types on every cable ✓ · hellos 100 (Linux 104) | ✓ |
| ospf-p2p | cable restored | R1: eth0: 2.2.2.2 Full/-, eth1: 3.3.3.3 Full/-; R2: eth0: 1.1.1.1 Full/-, eth1: 3.3.3.3 Full/-; R3: eth0: 1.1.1.1 Full/-, eth1: 2.2.2.2 Full/- | neighbors ✓, interfaces ✓, routes ✓, database ✓, last hello on every cable ✓, packet types on every cable ✓ · hellos 152 (Linux 150) | ✓ |
| ospf-p2p | ping H1 → 10.3.0.10 at 22 s | ok from 10.3.0.10 | result | ✓ |
| ospf-p2p | ping H1 → 10.3.0.10 at 47 s | ok from 10.3.0.10 | result | ✓ |
| ospf-p2p | ping H1 → 10.3.0.10 at 72 s | ok from 10.3.0.10 | result | ✓ |
| ospf-timers | converged: R1-R2 are not neighbors (dead interval 4 vs 8) | R1: eth1: 3.3.3.3 Full/-; R2: eth1: 3.3.3.3 Full/-; R3: eth0: 1.1.1.1 Full/-, eth1: 2.2.2.2 Full/- | neighbors ✓, interfaces ✓, routes ✓, database ✓, last hello on every cable ✓, packet types on every cable ✓ · hellos 116 (Linux 113) | ✓ |
| ospf-timers | R2-R3 cut: R2 has no neighbors | R1: eth1: 3.3.3.3 Full/-; R2: no neighbors; R3: eth0: 1.1.1.1 Full/- | neighbors ✓, interfaces ✓, routes ✓, database ✓, last hello on every cable ✓, packet types on every cable ✓ · hellos 100 (Linux 103) | ✓ |
| ospf-timers | R2-R3 restored (hello 2 s / dead 8 s) | R1: eth1: 3.3.3.3 Full/-; R2: eth1: 3.3.3.3 Full/-; R3: eth0: 1.1.1.1 Full/-, eth1: 2.2.2.2 Full/- | neighbors ✓, interfaces ✓, routes ✓, database ✓, last hello on every cable ✓, packet types on every cable ✓ · hellos 126 (Linux 126) | ✓ |
| ospf-timers | ping H1 → 10.3.0.10 at 22 s | ok from 10.3.0.10 | result | ✓ |
| ospf-timers | ping H1 → 10.3.0.10 at 47 s | ok from 10.3.0.10 | result | ✓ |
| ospf-timers | ping H1 → 10.3.0.10 at 72 s | ok from 10.3.0.10 | result | ✓ |
| ospf-lan | converged: R3 is DR, R2 BDR | R1: eth0: 2.2.2.2 Full/Backup, eth0: 3.3.3.3 Full/DR; R2: eth0: 1.1.1.1 Full/DROther, eth0: 3.3.3.3 Full/DR; R3: eth0: 1.1.1.1 Full/DROther, eth0: 2.2.2.2 Full/Backup | neighbors ✓, interfaces ✓, routes ✓, database ✓, last hello on every cable ✓, packet types on every cable ✓ · hellos 247 (Linux 242) | ✓ |
| ospf-lan | R3 cut: R2 is DR, R1 BDR | R1: eth0: 2.2.2.2 Full/DR; R2: eth0: 1.1.1.1 Full/Backup; R3: no neighbors | neighbors ✓, interfaces ✓, routes ✓, database ✓, last hello on every cable ✓, packet types on every cable ✓ · hellos 156 (Linux 161) | ✓ |
| ospf-lan | R3 back as DROther (no preemption) | R1: eth0: 2.2.2.2 Full/DR, eth0: 3.3.3.3 Full/DROther; R2: eth0: 1.1.1.1 Full/Backup, eth0: 3.3.3.3 Full/DROther; R3: eth0: 1.1.1.1 Full/Backup, eth0: 2.2.2.2 Full/DR | neighbors ✓, interfaces ✓, routes ✓, database ✓, last hello on every cable ✓, packet types on every cable ✓ · hellos 276 (Linux 275) | ✓ |
| ospf-lan | ping H1 → 10.3.0.10 at 22 s | ok from 10.3.0.10 | result | ✓ |
| ospf-lan | ping H1 → 10.3.0.10 at 47 s | net unreachable from 10.1.0.1 | result | ✓ |
| ospf-lan | ping H1 → 10.3.0.10 at 72 s | ok from 10.3.0.10 | result | ✓ |
| ospf-priority | converged: R1 is DR, R2 BDR | R1: eth0: 2.2.2.2 Full/Backup, eth0: 3.3.3.3 Full/DROther; R2: eth0: 1.1.1.1 Full/DR, eth0: 3.3.3.3 Full/DROther; R3: eth0: 1.1.1.1 Full/DR, eth0: 2.2.2.2 Full/Backup | neighbors ✓, interfaces ✓, routes ✓, database ✓, last hello on every cable ✓, packet types on every cable ✓ · hellos 201 (Linux 198) | ✓ |
| ospf-priority | R1 cut: R2 is DR, no BDR | R1: no neighbors; R2: eth0: 3.3.3.3 Full/DROther; R3: eth0: 2.2.2.2 Full/DR | neighbors ✓, interfaces ✓, routes ✓, database ✓, last hello on every cable ✓, packet types on every cable ✓ · hellos 106 (Linux 106) | ✓ |
| ospf-priority | R1 back as DROther | R1: eth0: 2.2.2.2 Full/DR, eth0: 3.3.3.3 Full/DROther; R2: eth0: 1.1.1.1 Full/Backup, eth0: 3.3.3.3 Full/DROther; R3: eth0: 1.1.1.1 Full/Backup, eth0: 2.2.2.2 Full/DR | neighbors ✓, interfaces ✓, routes ✓, database ✓, last hello on every cable ✓, packet types on every cable ✓ · hellos 226 (Linux 225) | ✓ |
| ospf-priority | ping H1 → 10.3.0.10 at 22 s | ok from 10.3.0.10 | result | ✓ |
| ospf-priority | ping H3 → 10.1.0.10 at 47 s | net unreachable from 10.3.0.1 | result | ✓ |
| ospf-priority | ping H1 → 10.3.0.10 at 72 s | ok from 10.3.0.10 | result | ✓ |
| ospf-mixed | converged: R3 DR, R4 BDR | R1: eth0: 2.2.2.2 Full/-; R2: eth0: 1.1.1.1 Full/-, eth1: 3.3.3.3 Full/DR, eth1: 4.4.4.4 Full/Backup; R3: eth0: 2.2.2.2 Full/DROther, eth0: 4.4.4.4 Full/Backup; R4: eth0: 2.2.2.2 Full/DROther, eth0: 3.3.3.3 Full/DR, eth1: 5.5.5.5 Full/-; R5: eth0: 4.4.4.4 Full/- | neighbors ✓, interfaces ✓, routes ✓, database ✓, last hello on every cable ✓, packet types on every cable ✓ · hellos 293 (Linux 291) | ✓ |
| ospf-mixed | R2 cut from the LAN | R1: eth0: 2.2.2.2 Full/-; R2: eth0: 1.1.1.1 Full/-; R3: eth0: 4.4.4.4 Full/Backup; R4: eth0: 3.3.3.3 Full/DR, eth1: 5.5.5.5 Full/-; R5: eth0: 4.4.4.4 Full/- | neighbors ✓, interfaces ✓, routes ✓, database ✓, last hello on every cable ✓, packet types on every cable ✓ · hellos 206 (Linux 208) | ✓ |
| ospf-mixed | R2 back as DROther | R1: eth0: 2.2.2.2 Full/-; R2: eth0: 1.1.1.1 Full/-, eth1: 3.3.3.3 Full/DR, eth1: 4.4.4.4 Full/Backup; R3: eth0: 2.2.2.2 Full/DROther, eth0: 4.4.4.4 Full/Backup; R4: eth0: 2.2.2.2 Full/DROther, eth0: 3.3.3.3 Full/DR, eth1: 5.5.5.5 Full/-; R5: eth0: 4.4.4.4 Full/- | neighbors ✓, interfaces ✓, routes ✓, database ✓, last hello on every cable ✓, packet types on every cable ✓ · hellos 326 (Linux 323) | ✓ |
| ospf-mixed | ping H1 → 10.5.0.10 at 22 s | ok from 10.5.0.10 | result | ✓ |
| ospf-mixed | ping H1 → 10.5.0.10 at 47 s | net unreachable from 10.1.0.1 | result | ✓ |
| ospf-mixed | ping H1 → 10.5.0.10 at 72 s | ok from 10.5.0.10 | result | ✓ |
