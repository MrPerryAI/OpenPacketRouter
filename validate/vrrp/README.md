# VRRP validation (engine vs keepalived)

`run_kernel_vrrp.py` builds each spec in Linux namespaces (one `keepalived` per router, veth cables, a bridge for the switch), plays the same steps in the engine, and compares at every snapshot. Run it with `validate/docker/run.sh vrrp` (CI does this).

Compared exactly:

- which routers are master (the virtual address is configured on the interface only while keepalived is master);
- whether a host can ping the virtual address;
- the set of distinct advertisements per cable direction (source, vrid, priority, interval, TTL, destination MAC).

No tolerance on counts: the advertisements per cable direction between two snapshots are compared **exactly**, counted from the first advert after the previous snapshot over whole advert intervals that end mid-interval, the same span on both sides. That removes the phase difference between keepalived's real-time timers (it starts a fraction of a second after the engine's clock zero) and the engine's clock without loosening anything. Snapshots sit on plateaus (seconds after each change) because the exact instant of a takeover differs slightly on a loaded kernel.

Known differences are listed in `mismatches.json`.
