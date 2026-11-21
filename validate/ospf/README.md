# OSPFv2 vs FRRouting ospfd

`run_kernel_ospf.py` builds each network in Linux namespaces, runs one `zebra` + `ospfd` (FRRouting) per router
and the same steps in the engine (`engine/tools/run_ospf.mjs`), then compares neighbor states, DR/BDR,
the routes ospfd installs, the link state database and the OSPF packets on every cable. On a Mac:
`validate/docker/run.sh ospf`. The result table is [results.md](results.md); a mismatch lists both sides in
`mismatches.json`.

| Network | What it covers |
|---|---|
| `ospf-p2p` | A ring of point-to-point links with unequal costs (no ties: the engine does not forward over equal-cost paths), passive host LANs. One cable cut and repaired. |
| `ospf-timers` | The p2p ring with three timer settings: R1-R2 differ in dead interval (4 s vs 8 s, so neither accepts the other's Hellos and no adjacency forms), R2-R3 both use hello 2 s / dead 8 s (adjacent), R1-R3 default. One cable cut and restored. |
| `ospf-lan` | Three routers on a switched LAN: the highest router ID is DR. The DR's cable is cut (BDR takes over) and repaired (no preemption). |
| `ospf-priority` | DR election by priority, one router with priority 0 (never DR or BDR). Host LANs are passive interfaces. |
| `ospf-mixed` | Five routers: point-to-point links on both sides of a transit LAN with DR R3 / BDR R4, so paths cross a network LSA and LSAs are flooded over several hops; passive host LANs, unequal costs. A router's LAN cable is cut and repaired. |

The specs end in `.net`, not `.json`, on purpose: `cli/test/roundtrip.test.js` reads every `*.json` spec in
`validate/` and `examples/` and needs a CLI command for every key in them. OSPF gets its CLI commands in a later
change; then these files can be renamed.

FRR originates a router LSA (and a network LSA, as DR) on every neighbor or interface state change even when the contents are the same, at most once every 5 s; the engine does the same, which is what makes the packet types on every cable match.

Timers are short (hello 1 s, dead 4 s) so a full run takes about five minutes. ospfd's own timing is real time, so
the comparison is of states after convergence, not of exact send times: Hello counts are shown in the table, and
which packet types crossed each cable (other than Hello) is compared, not how many.
One exception: a Link State Request on a switched LAN is compared per switch ("one crossed SW"), not per cable. A router that rejoins a LAN is adjacent to two or more routers at once and asks each only for the LSAs still missing when that neighbor's Database Description arrives; which neighbor's updates arrive first is a race in real time, so ospfd skips the request to one of them in some runs (seen in 6 of 9 runs of `ospf-lan` under CPU load). The engine asks both.
