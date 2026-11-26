# VRRP gateway

**What it shows:** Two routers sharing one gateway address with VRRP. When the master loses its cable, the backup takes over the address and the host's pings keep working.

**The network:** Host H1 (`10.0.0.10`, gateway `10.0.0.254`) and routers R1 (`10.0.0.1`) and R2 (`10.0.0.2`) all connect to switch S1. R1 and R2 both hold VRRP group 1 for `10.0.0.254`: R1 has priority 200, R2 has 100.

## Run it

```bash
node engine/bin/openpacketrouter.mjs run examples/vrrp-gateway/spec.json examples/vrrp-gateway/actions.json --text
```

The run waits 8 s, pings `10.0.0.254`, cuts R1's cable, waits, pings again, restores the cable, waits, and pings a third time. `--text` shows the VRRP adverts and ARP replies that go by.

## Try it on a device console

Open a console with `node cli/bin/opr-cli.mjs examples/vrrp-gateway/spec.json DEVICE`, or use the Studio. Type `?` at any point to see what is allowed.

On **R1**:

```console
R1> enable
R1> show vrrp
R1> show running-config
```

- `enable`: Privileged mode.
- `show vrrp`: One row per group: interface, group number, state, who the master is, the shared address, priority, advert interval and whether it preempts. Add `| json` for machine-readable output.
- `show running-config`: The `vrrp 1 address` and `vrrp 1 priority` lines under `eth0`.

On **R2**:

```console
R2> enable
R2> show vrrp
```

- `show vrrp`: The same view from the backup's side.

## What to expect

- After about 3 s R1 becomes master (the first ping is answered by R1) and R2 stays backup.
- After the cut, R2 misses R1's adverts, becomes master within a few seconds, and answers the next ping to `10.0.0.254`.
- When the cable returns, R1 sees a lower-priority master, preempts, and is master again.

## Change something

On R1, run `vrrp 1 no-preempt` under `eth0` (in configure mode): after the cable returns, R2 stays master. Or lower R1's priority below 100 with `vrrp 1 priority 50` and R2 wins from the start.

More detail for the curious: [the lab's own README](../../examples/vrrp-gateway/README.md).
