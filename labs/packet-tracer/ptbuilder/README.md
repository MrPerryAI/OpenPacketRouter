# One-click builds with PTBuilder

These scripts build the lab's `.pkt` files **inside Packet Tracer** in about a minute: devices, cables, every switch and router config, and every PC and server IP. They use [PTBuilder](https://github.com/kimmknight/PTBuilder), a free Packet Tracer extension that runs JavaScript through Packet Tracer's own scripting interface.

## One-time setup (about 2 minutes)

1. Download **`Builder.pts`** from the [PTBuilder repo](https://github.com/kimmknight/PTBuilder).
2. In Packet Tracer: **Extensions → Scripting → Configure PT Script Modules → Add…** and pick `Builder.pts`.
3. You'll now have **Extensions → Builder Code Editor**.

## Build the three lab files

For each script, start from an **empty workspace**:

| Script | Builds | Save as |
|---|---|---|
| [`build-1-baseline.js`](build-1-baseline.js) | End of Part 1. A clean, working network that students start from. | `pkt/faa-ftl-baseline.pkt` |
| [`build-2-cutover.js`](build-2-cutover.js) | End of Part 2 step 5. The storm is one ping away. | `pkt/faa-ftl-cutover.pkt` |
| [`build-3-final.js`](build-3-final.js) | End of Part 4. Routed edge and hardened (teacher reference). | `pkt/faa-ftl-final.pkt` |

1. **File → New**
2. **Extensions → Builder Code Editor**, paste the whole script, and click **Run**.
3. Wait for the **DONE** message. If it says **FINISHED WITH PROBLEMS**, it lists exactly which device or cable failed.
4. Click **Fast Forward Time** a few times so the links come up and spanning tree settles.
5. Spot-check with a ping or two from [Part 1, step 5](../labs/part1-build-baseline.md#5-verify).
6. **File → Save As** the name in the table, then commit the `.pkt` to this repo.

After that, students just open the `.pkt` and never need PTBuilder.

## Keeping scripts in sync

The scripts are **generated** from `configs/`, so the handouts and the builds always match. If you change a config file, regenerate:

```bash
python3 tools/make_ptbuilder.py
```

## If something goes wrong

- **A device or cable fails to add:** the model or port name may differ in your Packet Tracer version. The message names the item, and you can add it by hand using [docs/topology.md](../docs/topology.md).
- **A config line is rejected:** open that device's CLI and paste its file from `configs/` by hand. The Part 1 handout covers this.
- These scripts have been checked for syntax and for valid device and port references. **They have not yet been run in Packet Tracer itself.** Please report or commit fixes after your first run.
