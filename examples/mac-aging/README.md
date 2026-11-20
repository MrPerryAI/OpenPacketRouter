# MAC address aging

A, B and C share one subnet. A and B plug into SW1, C into SW2, and the two switches are cabled together. Switches learn which port each MAC address lives on, and forget an address that has been silent for the **aging time** (`agingTime` in the spec, 300 s by default; a Linux bridge's `ageing_time`). Here SW1 uses 5 s and SW2 uses 12 s so the difference shows.

```bash
node engine/bin/openpacketrouter.mjs run examples/mac-aging/spec.json examples/mac-aging/actions.json --text
```

| Step | What happens | Why |
|---|---|---|
| ping A → C | the ARP broadcast floods everywhere (B sees it); the echo request and reply are unicast | both switches learn A and C |
| wait 8 s | SW1's table is empty; SW2 still lists A and C | 8 s is more than SW1's 5 s and less than SW2's 12 s |
| ping A → C again (ARP caches kept) | SW1 **floods** the echo request, so B receives a copy; SW2 forwards it only toward C | SW1 forgot where C is, SW2 did not |

On the CLI: `mac address-table aging-time 5` (config mode) sets it, and `show mac address-table` lists each entry's age (add `| json` for data).
