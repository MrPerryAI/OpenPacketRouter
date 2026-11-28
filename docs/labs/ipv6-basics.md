# IPv6 basics

**What it shows:** IPv6 addresses on interfaces, neighbor discovery instead of ARP, ping, and a static route.

**The network:** A and B share 2001:db8:1::/64 through a switch; router R connects it to C on 2001:db8:2::/64.

## Run it

```bash
node engine/bin/openpacketrouter.mjs run examples/ipv6-basics/spec.json examples/ipv6-basics/actions.json --text
```

`--text` prints a readable report of what every device did. Without it you get JSON with the frames on each cable.

## Try it on a device console

Open a console with `node cli/bin/opr-cli.mjs examples/ipv6-basics/spec.json DEVICE`, or use the Studio. Type `?` at any point to see what is allowed.

On **R**:

```console
R> enable
R> show running-config
R> show ipv6 route
```

- `show running-config`: the IPv6 address on each interface.
- `show ipv6 route`: the two connected networks.

On **C**:

```console
C> enable
C> show running-config
C> show ipv6 route
```

- `show running-config`: the static route that sends traffic for 2001:db8:1::/64 to R.

## What to expect

- The first ping from A to B starts with a neighbor solicitation and an advertisement; then the echo.
- A to C goes through R; with hop limit 1 R answers with a time exceeded message.
- A ping to an unused address on the LAN gets no neighbor advertisement and fails.

## Change something

Remove the static route on C and ping A again: the reply cannot find its way back.
