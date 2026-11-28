# OSPF with three areas

```
 H1 - R1 -- R2 ==[ area 0: switch ]== R4 -- R5 - H5
                       |  R3 - H3
```

Area 0 is a switch with R2, R3 and R4 on it. R2 is the ABR to area 1 (R1 and H1) and R4 is the ABR to area 2 (R5 and H5). R3 sits in the backbone with H3.

```bash
node engine/bin/openpacketrouter.mjs run examples/ospf-areas/spec.json examples/ospf-areas/actions.json --text
node cli/bin/opr-cli.mjs examples/ospf-areas/spec.json R1
```

| Step | What to see |
|---|---|
| after 25 s | Pings between H1 and H5 work: they cross two area borders. |
| R1-R2 cable cut | Area 1 is split off from the backbone; the ping from H1 fails. |
| cable restored | Adjacency forms again and the ping works. |

In the console on R1:

- the OSPF database: R1 holds only area 1's own router LSAs plus type 3 summaries from R2.

The ABR parts match FRRouting ospfd on routes, LSDBs and packets ([validate/ospf/results.md](../../validate/ospf/results.md)).
