# Port security

**What it shows:** A switch port that only accepts a limited number of source MAC addresses: the first one heard is secured, the others are dropped and counted.

**The network:** A and B share a small switch HUB whose uplink plugs into SW1 port `p1`. SW1 allows one address on `p1` and restricts the rest. C sits on SW1 `p2` with no limit.

## Run it

```bash
node engine/bin/openpacketrouter.mjs run examples/port-security/spec.json examples/port-security/actions.json --text
```

`--text` prints a readable report of what every device did. Without it you get JSON with the frames on each cable.

## Try it on a device console

Each device has a console. Open one with `node cli/bin/opr-cli.mjs examples/port-security/spec.json DEVICE`, or use the Studio. Type `?` at any point to see what is allowed.

On **SW1**:

```console
SW1> enable
SW1> show port-security
SW1> show running-config
```

- `enable`: Privileged mode.
- `show port-security`: Each port's limit, secured addresses and violation count (add `| json` for machine-readable output).
- `show running-config`: The `switchport port-security` lines on `p1`.

## What to expect

- A pings C and it works: A's address is the first heard on `p1`, so it is secured for good.
- B pings C and times out. B is a second address on a port that allows one, so SW1 drops its frames before learning them and counts violations.
- A pings C again and it still works.

## Change something

Raise the limit with `switchport port-security maximum 2` on `p1` (or `max` in the spec): now B gets through too. The other violation modes are `protect` (drop quietly) and `shutdown` (drop and take the port down).

More detail for the curious: [the lab's own README](../../examples/port-security/README.md).
