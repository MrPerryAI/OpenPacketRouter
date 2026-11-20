#!/usr/bin/env bash
# Run the root/namespace validations inside a privileged Linux container, never with sudo on the Mac.
#   validate/docker/run.sh            # all kernel validations (validate/l3 + poc/storm-math run_kernel.py)
#   validate/docker/run.sh l3         # just the engine-vs-Linux L3 check
#   validate/docker/run.sh storm      # just the storm-math kernel-bridge check
#   validate/docker/run.sh links      # just the link-shaping (tbf) check
#   validate/docker/run.sh tcp        # just the TCP check (python sockets)
#   validate/docker/run.sh dhcp       # just the DHCP check (dnsmasq + udhcpc)
#   validate/docker/run.sh rip        # just the RIPv2 check (FRRouting ripd)
#   validate/docker/run.sh cli        # the device CLI's Linux rendering vs the engine (validate/cli)
#   validate/docker/run.sh intervlan  # just the inter-VLAN routing check (subinterfaces + SVIs)
#   validate/docker/run.sh full       # every check in CLAUDE.md except the browser smoke test
#   validate/docker/run.sh -- CMD...  # any command, as root, in /repo (e.g. python3 validate/l2/run_kernel_l2.py)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${OPR_VALIDATE_IMAGE:-openpacketrouter-validate}"
docker build -q -t "$IMAGE" "$ROOT/validate/docker" >/dev/null

l3='python3 validate/l3/run_kernel_l3.py'
l2='python3 validate/l2/run_kernel_l2.py'
storm='cd poc/storm-math && python3 run_kernel.py'
links='python3 validate/links/run_kernel_links.py'
dhcp='python3 validate/dhcp/run_kernel_dhcp.py'
tcp='python3 validate/tcp/run_kernel_tcp.py'
cli='python3 validate/cli/run_kernel_cli.py'
intervlan='python3 validate/intervlan/run_kernel_intervlan.py'
rip='python3 validate/rip/run_kernel_rip.py'
full='set -e; python3 tools/build_web.py --check; (cd poc/storm-math && python3 -m pytest -q); python3 -m pytest -q tests; (cd engine && npm test); (cd cli && npm test); '"$l3"'; '"$l2"'; '"$links"'; '"$dhcp"'; '"$tcp"'; '"$cli"'; '"$intervlan"'; '"$rip"'; ('"$storm"')'

case "${1:-all}" in
  l3)    cmd="$l3" ;;
  l2)    cmd="$l2" ;;
  storm) cmd="$storm" ;;
  links) cmd="$links" ;;
  dhcp)  cmd="$dhcp" ;;
  tcp)   cmd="$tcp" ;;
  cli)   cmd="$cli" ;;
  intervlan) cmd="$intervlan" ;;
  rip)   cmd="$rip" ;;
  all)   cmd="set -e; $l3; $l2; $links; $dhcp; $tcp; $cli; $intervlan; $rip; ($storm)" ;;
  full)  cmd="$full" ;;
  --)    shift; cmd="$*" ;;
  *)     echo "usage: $0 [l3|l2|links|dhcp|tcp|cli|intervlan|rip|storm|all|full|-- CMD...]" >&2; exit 2 ;;
esac

# --privileged: namespaces, veth, bridges, qdiscs and sysctls need CAP_SYS_ADMIN/CAP_NET_ADMIN.
# --rm: nothing persists; every run starts clean. PYTHONDONTWRITEBYTECODE keeps root-owned
# __pycache__ files out of the bind-mounted checkout.
exec docker run --rm --privileged -e PYTHONDONTWRITEBYTECODE=1 \
  -v "$ROOT":/repo -w /repo "$IMAGE" bash -c "$cmd"
