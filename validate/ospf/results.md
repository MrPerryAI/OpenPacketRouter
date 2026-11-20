| Network | Snapshot | Engine neighbors (same in ospfd?) | Checks | Match |
|---|---|---|---|---|
| ospf-lan | converged: R3 is DR, R2 BDR | R1: eth0: 2.2.2.2 Full/Backup, eth0: 3.3.3.3 Full/DR; R2: eth0: 1.1.1.1 Full/DROther, eth0: 3.3.3.3 Full/DR; R3: eth0: 1.1.1.1 Full/DROther, eth0: 2.2.2.2 Full/Backup | neighbors ✓, interfaces ✓, routes ✓, database ✓, last hello on every cable ✓, packet types on every cable ✓ · hellos 247 (Linux 242) | ✓ |
| ospf-lan | R3 cut: R2 is DR, R1 BDR | R1: eth0: 2.2.2.2 Full/DR; R2: eth0: 1.1.1.1 Full/Backup; R3: no neighbors | neighbors ✓, interfaces ✓, routes ✓, database ✓, last hello on every cable ✓, packet types on every cable ✓ · hellos 156 (Linux 161) | ✓ |
| ospf-lan | R3 back as DROther (no preemption) | R1: eth0: 2.2.2.2 Full/DR, eth0: 3.3.3.3 Full/DROther; R2: eth0: 1.1.1.1 Full/Backup, eth0: 3.3.3.3 Full/DROther; R3: eth0: 1.1.1.1 Full/Backup, eth0: 2.2.2.2 Full/DR | neighbors ✓, interfaces ✓, routes ✓, database ✓, last hello on every cable ✓, packet types on every cable ✓ · hellos 276 (Linux 275) | ✓ |
| ospf-lan | ping H1 → 10.3.0.10 at 22 s | ok from 10.3.0.10 | result | ✓ |
| ospf-lan | ping H1 → 10.3.0.10 at 47 s | net unreachable from 10.1.0.1 | result | ✓ |
| ospf-lan | ping H1 → 10.3.0.10 at 72 s | ok from 10.3.0.10 | result | ✓ |
| ospf-priority | converged: R1 is DR, R2 BDR | R1: eth0: 2.2.2.2 Full/Backup, eth0: 3.3.3.3 Full/DROther; R2: eth0: 1.1.1.1 Full/DR, eth0: 3.3.3.3 Full/DROther; R3: eth0: 1.1.1.1 Full/DR, eth0: 2.2.2.2 Full/Backup | neighbors ✓, interfaces ✓, routes ✓, database ✓, last hello on every cable ✓, packet types on every cable ✓ · hellos 247 (Linux 239) | ✓ |
| ospf-priority | R1 cut: R2 is DR, no BDR | R1: no neighbors; R2: eth0: 3.3.3.3 Full/DROther; R3: eth0: 2.2.2.2 Full/DR | neighbors ✓, interfaces ✓, routes ✓, database ✓, last hello on every cable ✓, packet types on every cable ✓ · hellos 156 (Linux 161) | ✓ |
| ospf-priority | R1 back as DROther | R1: eth0: 2.2.2.2 Full/DR, eth0: 3.3.3.3 Full/DROther; R2: eth0: 1.1.1.1 Full/Backup, eth0: 3.3.3.3 Full/DROther; R3: eth0: 1.1.1.1 Full/Backup, eth0: 2.2.2.2 Full/DR | neighbors ✓, interfaces ✓, routes ✓, database ✓, last hello on every cable ✓, packet types on every cable ✓ · hellos 276 (Linux 275) | ✓ |
| ospf-priority | ping H1 → 10.3.0.10 at 22 s | ok from 10.3.0.10 | result | ✓ |
| ospf-priority | ping H3 → 10.1.0.10 at 47 s | net unreachable from 10.3.0.1 | result | ✓ |
| ospf-priority | ping H1 → 10.3.0.10 at 72 s | ok from 10.3.0.10 | result | ✓ |
| ospf-p2p | converged | R1: eth0: 2.2.2.2 Full/-, eth1: 3.3.3.3 Full/-; R2: eth0: 1.1.1.1 Full/-, eth1: 3.3.3.3 Full/-; R3: eth0: 1.1.1.1 Full/-, eth1: 2.2.2.2 Full/- | neighbors ✓, interfaces ✓, routes ✓, database ✓, last hello on every cable ✓, packet types on every cable ✓ · hellos 184 (Linux 181) | ✓ |
| ospf-p2p | R1-R2 cut: R1 uses the direct link | R1: eth1: 3.3.3.3 Full/-; R2: eth1: 3.3.3.3 Full/-; R3: eth0: 1.1.1.1 Full/-, eth1: 2.2.2.2 Full/- | neighbors ✓, interfaces ✓, routes ✓, database ✓, last hello on every cable ✓, packet types on every cable ✓ · hellos 150 (Linux 153) | ✓ |
| ospf-p2p | cable restored | R1: eth0: 2.2.2.2 Full/-, eth1: 3.3.3.3 Full/-; R2: eth0: 1.1.1.1 Full/-, eth1: 3.3.3.3 Full/-; R3: eth0: 1.1.1.1 Full/-, eth1: 2.2.2.2 Full/- | neighbors ✓, interfaces ✓, routes ✓, database ✓, last hello on every cable ✓, packet types on every cable ✓ · hellos 202 (Linux 200) | ✓ |
| ospf-p2p | ping H1 → 10.3.0.10 at 22 s | ok from 10.3.0.10 | result | ✓ |
| ospf-p2p | ping H1 → 10.3.0.10 at 47 s | ok from 10.3.0.10 | result | ✓ |
| ospf-p2p | ping H1 → 10.3.0.10 at 72 s | ok from 10.3.0.10 | result | ✓ |
