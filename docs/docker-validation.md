# Root validation on a Mac (privileged Linux Docker container)

The engine is validated frame for frame against real Linux: network namespaces, veth pairs, kernel
bridges, qdiscs. That needs root on a Linux kernel. On a Mac, **never run these with `sudo` on the host**;
run them inside a throwaway privileged Linux container instead. Docker Desktop's Linux VM kernel has
namespaces, veth, bridges (STP, VLAN filtering) and the `tbf`/`htb`/`pfifo` qdiscs.

## One command

From the repo root:

```bash
validate/docker/run.sh            # validate/l3/run_kernel_l3.py + poc/storm-math/run_kernel.py
validate/docker/run.sh l3         # only the engine-vs-Linux L3 check
validate/docker/run.sh storm      # only the storm-math kernel-bridge check
validate/docker/run.sh full       # every CLAUDE.md check except the browser smoke test
validate/docker/run.sh -- python3 validate/l2/run_kernel_l2.py   # any command, as root, in /repo
```

What it does:

1. Builds `validate/docker/Dockerfile` (Debian + Node 22 + Python 3, numpy, pytest, iproute2,
   `unshare`, tcpdump) as image `openpacketrouter-validate` (cached after the first build).
2. Runs `docker run --rm --privileged -v "$PWD":/repo -w /repo …` with the chosen command.
   The checkout is bind-mounted, so the container always tests your working tree; nothing persists.

The scripts already isolate themselves with `unshare -n -m` and a private `/run`, so they leave nothing
behind even inside the container.

## New validators

Put new kernel harnesses next to their feature (`validate/l2/`, `validate/links/`, `validate/dhcp/` …),
make them skip politely without root like `run_kernel_l3.py` does, and add them to:

- the `all`/`full` cases in `validate/docker/run.sh`, and
- `.github/workflows/ci.yml` (`sudo env "PATH=$PATH" GITHUB_ACTIONS=true python3 …`), so GitHub CI runs them on every PR.

On a mismatch, call `l3.gh_note("error", "<Feature> engine vs Linux mismatch", json.dumps(detail))` (from
`validate/l3/run_kernel_l3.py`) so the detail shows up as a GitHub annotation. `sudo` drops environment variables,
so the CI step passes `GITHUB_ACTIONS=true` itself.

## If Docker isn't reachable

Agents running under a macOS sandbox may get `connect: operation not permitted` on
`~/.docker/run/docker.sock`, or a build that hangs because Docker Hub and package mirrors are blocked.
That's the sandbox, not Docker. Two fallbacks:

- **GitHub CI** runs every root validation with `sudo` on `ubuntu-latest` for each push and PR
  (`gh pr checks <n>` / `gh run view --log-failed`). This is the reference result for merging.
  If the raw log can't be downloaded either (it lives on a separate blob host), read the failed step
  and the mismatch annotations through the API:

  ```bash
  job=$(gh pr view <n> --json statusCheckRollup --jq '.statusCheckRollup[0].detailsUrl' | sed 's#.*/job/##')
  gh api repos/MrPerryAI/OpenPacketRouter/actions/jobs/$job --jq '.steps[] | .name + ": " + .conclusion'
  gh api repos/MrPerryAI/OpenPacketRouter/check-runs/$job/annotations --jq '.[] | .title + "\n" + .message'
  ```
  For the DHCP relay harness, `OPR_CAPTURE=1` adds a tcpdump of the relay router to that output.
- Ask a human to run `validate/docker/run.sh` in a normal terminal and paste the output.

## Troubleshooting

- `Needs root, unshare and iproute2. Skipping.` — you ran it outside the container (or without
  `--privileged`). Use `run.sh`.
- `RTNETLINK answers: Operation not supported` for a qdisc or link type — Docker Desktop's kernel lacks that
  module. Note it in the PR; CI's Ubuntu kernel is the reference.
- Root-owned files in the checkout: `run.sh` sets `PYTHONDONTWRITEBYTECODE=1`; anything else a validator
  writes should go to `$TMPDIR` inside the container.
