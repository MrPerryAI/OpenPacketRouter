# TCP across a router

**What it shows:** The TCP handshake, an echo, a clean close, and what a refused port and a silent host look like.

**The network:** CLIENT (10.1.0.10) reaches echo servers on 10.2.0.0/24 through R1. SERVER (10.2.0.10) has a route back; BROKEN (10.2.0.20) does not.

## Run it

```bash
node engine/bin/openpacketrouter.mjs run examples/tcp/spec.json examples/tcp/actions.json --text
```

`--text` prints a readable report of what every device did. Without it you get JSON with the frames on each cable.

## Try it on a device console

Each device has a console. Open one with `node cli/bin/opr-cli.mjs examples/tcp/spec.json DEVICE`, or use the Studio. Type `?` at any point to see what is allowed.

On **CLIENT**:

```console
CLIENT> ping 10.2.0.10
CLIENT> ping 10.2.0.20
```

- `ping 10.2.0.10`: Works.
- `ping 10.2.0.20`: Times out: BROKEN hears us but has no route to answer.

## What to expect

- To port 7 on SERVER you see SYN, SYN+ACK, ACK, the 100 bytes going out and coming back, then FIN exchanges.
- To port 8 the server answers RST: connection refused. To BROKEN the SYN is sent three times (after 1 s and 3 s) and the result is a timeout.

## Change something

Give BROKEN a `gw` of 10.2.0.1 and run again: the third test now works.

More detail for the curious: [the lab's own README](../../examples/tcp/README.md).
