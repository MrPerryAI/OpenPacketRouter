# VRRP gateway

Host H1 uses `10.0.0.254` as its gateway, but no router owns that address. R1 and R2 share it with VRRP: the router with the higher priority (R1, 200) is the *master* and answers for the address; R2 (priority 100) is the *backup* and listens for R1's adverts, one per second.

The actions wait for the election, ping the shared address, cut R1's cable, wait again, and ping again: R2 takes the address over once it has missed three adverts, so the ping still works. Restoring the cable lets R1 (which has `preempt` on) take the address back.

```bash
node engine/bin/openpacketrouter.mjs run examples/vrrp-gateway/spec.json examples/vrrp-gateway/actions.json --text
node cli/bin/opr-cli.mjs examples/vrrp-gateway/spec.json R1     # then: show vrrp
```

Each group is set on an interface with `vrrp GROUP address IP`, `vrrp GROUP priority N`, and `vrrp GROUP no-preempt`. The engine is validated against `keepalived` in `validate/vrrp`.
