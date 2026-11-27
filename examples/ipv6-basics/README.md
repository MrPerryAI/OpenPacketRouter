# IPv6 basics

A and B are on 2001:db8:1::/64 through a switch. Router R connects that network to C on 2001:db8:2::/64. No router advertisements: every address is set by hand, and C has a static route back to the first network.

```bash
node engine/bin/openpacketrouter.mjs run examples/ipv6-basics/spec.json examples/ipv6-basics/actions.json --text
node cli/bin/opr-cli.mjs examples/ipv6-basics/spec.json A
```

| Step | What to see |
|---|---|
| A pings B | A first sends a neighbor solicitation (to B's solicited-node multicast address) and B answers with a neighbor advertisement, then the echo request and reply. |
| A pings C | A sends to its gateway R: one neighbor exchange with R, then the packet is routed. Each router hop lowers the hop limit. |
| hop limit 1 | R answers with an ICMPv6 time exceeded message. |
| an unused address | The neighbor solicitation gets no answer; the ping fails with "destination unreachable" after the wait. |
| a prefix nobody routes | The host or router replies that there is no route. |

In the console, try `show ipv6 neighbors` and `show ipv6 route` on A, R and C after the pings. This matches Linux network namespaces on every frame ([validate/ipv6](../../validate/ipv6/)).
