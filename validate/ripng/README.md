# RIPng vs FRRouting ripngd

`run_kernel_ripng.py` builds the network in Linux namespaces, runs zebra and ripngd on every router with a `ripng` key, and compares
the engine with them at each snapshot of `ripng-chain.steps.json`: every router's RIPng table, the last periodic update on every cable
(every RTE in order, metric-255 next-hop entries included), the prefixes newly advertised with metric 16, the cables that carried a
Request, and ping results. Link-local addresses are random in Linux, so each fe80:: address is replaced by `NODE:iface` on both sides.

**Not compared:** exact send times and update counts, because ripngd randomises its update timer.

**`keep_addr_on_down=1`:** the `linkDown` / `linkUp` steps pull a cable. In the engine that changes only the carrier, but
`ip link set down` in Linux also deletes the interface's IPv6 addresses, and with them the connected routes. The validator sets
`net.ipv6.conf.IFACE.keep_addr_on_down=1` on every interface so the Linux step models the same thing (the IPv4 RIP validator
does not need this because IPv4 addresses survive `down`).
