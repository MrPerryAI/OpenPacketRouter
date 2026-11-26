# BGP-4 vs FRRouting bgpd

`run_kernel_bgp.py` builds each `*.net` spec from namespaces, runs zebra + bgpd in every router, and compares the engine
(`engine/tools/run_bgp.mjs`, same steps) with what bgpd does: sessions, the BGP table, routes in the kernel, what every
router announced to every neighbor, OPEN contents, message types, OPEN/NOTIFICATION counts and KEEPALIVE counts per cable (KEEPALIVEs over a window aligned on both sides: from the first one after the snapshot, whole intervals, ending mid-interval), and LOCAL_PREF in what iBGP peers are told. UPDATE counts are not compared: how bgpd groups them depends on its timing. `validate/docker/run.sh bgp` runs it on a Mac.
Files carry the `.net` extension so the CLI's round-trip test (which reads every `*.json`) leaves them alone.

| Spec | What it shows |
|---|---|
| bgp-chain | eBGP over three ASes; an eBGP session ends at once when its cable loses carrier |
| bgp-ibgp | iBGP, next-hop-self, an iBGP session that ends only when its hold timer runs out |
| bgp-paths | shortest AS path wins; fall back and return |
| bgp-localpref | a higher local preference beats a shorter AS path |

Not modelled: the IGP metric to the next hop (a best-path step after eBGP-over-iBGP), MED, weight, communities, route maps, multipath, route reflectors, confederations, IPv6, graceful restart.
