# IPv4 static routes: the CLI's FRR rendering in real FRR

`run_frr_static.py` builds the `validate/l3/fti-routed.json` network in Linux namespaces, but gives no router its static routes or default
gateway through `ip route`. Instead every router runs zebra and staticd, and loads the `ip route ...` lines of `opr-cli SPEC DEVICE --render frr`.
Then `ip route` of every host and router is compared with `engine/tools/dump_routes.mjs`: destination, next hop and interface, exactly.
The routes FRR installed must carry zebra's static protocol, so a route placed by anything else cannot make the comparison pass.

Run it with `validate/docker/run.sh frrstatic` (CI step "Static routes from the CLI's FRR rendering"). `results.md` and `mismatches.json`
are written by the run; in CI a mismatch is also printed and annotated.
