# Port security

A and B share a small switch (HUB) whose uplink plugs into SW1 port `p1`. SW1 allows **one** MAC address on `p1` (`switchport port-security maximum 1`) and *restricts* the rest (`violation restrict`). The first address heard on the port is secured for good; a frame from any other address is dropped before SW1 learns it, and counted.

```bash
node engine/bin/openpacketrouter.mjs run examples/port-security/spec.json examples/port-security/actions.json --text
```

| Step | What happens | Why |
|---|---|---|
| ping A → C | works | A is the first address on `p1`: it is secured |
| ping B → C | times out; SW1 counts violations | B is a second address on a port that allows one |
| ping A → C again | still works | A's address stays secured |

On the CLI, on SW1: `show port-security` (add `| json`) lists each port's limit, secured addresses and violation count. Violation modes: `protect` (drop), `restrict` (drop, count, log), `shutdown` (drop and take the port down; not compared against Linux, see docs/STATUS.md).
