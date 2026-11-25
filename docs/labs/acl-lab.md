# Access lists on a router

**What it shows:** Filtering traffic with ordered permit/deny rules on an interface, and what a denied sender is told.

**The network:** A (10.1.0.10) reaches server S (10.2.0.10) through R. R has lists FROM-LAN (in on eth0), TO-SERVERS (out on eth1) and TO-LAN (out on eth0).

## Run it

```bash
node engine/bin/openpacketrouter.mjs run examples/acl-lab/spec.json examples/acl-lab/actions.json --text
```

`--text` prints a readable report of what every device did. Without it you get JSON with the frames on each cable.

## Try it on a device console

Each device has a console. Open one with `node cli/bin/opr-cli.mjs examples/acl-lab/spec.json DEVICE`, or use the Studio. Type `?` at any point to see what is allowed.

On **R**:

```console
R> enable
R> show access-lists
```

- `enable`: Privileged mode.
- `show access-lists`: Every list, its rules in order, where it is applied and the implicit deny at the end.

On **A**:

```console
A> ping 10.2.0.10
```

- `ping 10.2.0.10`: Allowed: works.

## What to expect

- Ping and DNS pass. UDP to port 9000 is allowed in but refused by TO-SERVERS, so R answers `administratively prohibited`. Traffic matching no rule is silently dropped by the implicit deny at the end.
- UDP to port 8000 passes both lists, but the server's "port unreachable" reply cannot come back through TO-LAN, so the client just times out.

## Change something

Edit the lists in the spec (or use `ip access-list` and `ip access-group` on the console) and run again to see how one rule changes what gets through.

More detail for the curious: [the lab's own README](../../examples/acl-lab/README.md).
