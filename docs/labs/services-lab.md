# Syslog and NTP services

**What it shows:** A server that offers two network services, a log receiver and a time server, and a client that uses both.

**The network:** Client A (`10.0.0.1`) and server SRV (`10.0.0.10`) connect to switch SW. SRV has `service syslog` and `service ntp 2`.

## Run it

```bash
node engine/bin/openpacketrouter.mjs run examples/services-lab/spec.json examples/services-lab/actions.json --text
```

The first action sends the log message `link up on eth0`; the second asks SRV for the time. `--text` shows each datagram and what SRV did with it.

## Try it on a device console

Open a console with `node cli/bin/opr-cli.mjs examples/services-lab/spec.json DEVICE`, or use the Studio. Type `?` at any point to see what is allowed.

On **SRV**:

```console
SRV> enable
SRV> show ntp
SRV> show syslog
SRV> show running-config
```

- `enable`: Privileged mode.
- `show ntp`: Whether the time server is running, its stratum, and how many queries it has answered.
- `show syslog`: The messages the receiver has stored (add `| json` for machine-readable output).
- `show running-config`: The `service ntp 2` and `service syslog` lines.

On **A**:

```console
A> enable
A> ping 10.0.0.10
```

- `ping 10.0.0.10`: Checks that the server answers before you use its services.

## What to expect

- The syslog message arrives at SRV on UDP 514 with the tag `netmon`.
- The NTP query is answered at stratum 2.
- Run `no service syslog` on SRV (configure mode) and send the message again: the server answers with ICMP port unreachable instead of storing it.

More detail for the curious: [the lab's own README](../../examples/services-lab/README.md).
