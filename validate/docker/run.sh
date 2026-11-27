#!/usr/bin/env bash
# Run the root/namespace validations inside a privileged Linux container, never with sudo on the Mac.
#   validate/docker/run.sh            # all kernel validations (validate/l3 + poc/storm-math run_kernel.py)
#   validate/docker/run.sh l3         # just the engine-vs-Linux L3 check
#   validate/docker/run.sh storm      # just the storm-math kernel-bridge check
#   validate/docker/run.sh links      # just the link-shaping (tbf) check
#   validate/docker/run.sh services   # just the server-services check (syslog via util-linux logger, NTP via ntpdate)
#   validate/docker/run.sh tcp        # just the TCP check (python sockets)
#   validate/docker/run.sh dhcp       # just the DHCP check (dnsmasq + udhcpc)
#   validate/docker/run.sh ospf       # just the OSPFv2 check (FRRouting ospfd)
#   validate/docker/run.sh bgp        # just the BGP-4 check (FRRouting bgpd)
#   validate/docker/run.sh lldp       # just the LLDP check (lldpd)
#   validate/docker/run.sh vrrp       # just the VRRP check (keepalived)
#   validate/docker/run.sh rip        # just the RIPv2 check (FRRouting ripd)
#   validate/docker/run.sh acl        # just the access-list check (nftables)
#   validate/docker/run.sh nat        # just the NAT check (nftables masquerade/snat/dnat)
#   validate/docker/run.sh span       # just the port-mirroring check (tc mirred)
#   validate/docker/run.sh ripng      # just the RIPng check (FRRouting ripngd)
#   validate/docker/run.sh ipv6       # just the IPv6 check (addresses, neighbor discovery, ICMPv6 echo, static routes)
#   validate/docker/run.sh cli        # the device CLI's Linux rendering vs the engine (validate/cli)
#   validate/docker/run.sh intervlan  # just the inter-VLAN routing check (subinterfaces + SVIs)
#   validate/docker/run.sh aging      # just the MAC-aging check (kernel bridge ageing_time)
#   validate/docker/run.sh tcn        # just the spanning-tree topology-change check (TCN BPDUs, aging)
#   validate/docker/run.sh lacp       # just the link-aggregation check (kernel bond, mode 802.3ad)
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
services='python3 validate/services/run_kernel_services.py'
cli='python3 validate/cli/run_kernel_cli.py'
intervlan='python3 validate/intervlan/run_kernel_intervlan.py'
ospf='python3 validate/ospf/run_kernel_ospf.py'
lldp='python3 validate/lldp/run_kernel_lldp.py'
aging='python3 validate/aging/run_kernel_aging.py'
rip='python3 validate/rip/run_kernel_rip.py'
bgp='python3 validate/bgp/run_kernel_bgp.py'
tcn='python3 validate/tcn/run_kernel_tcn.py'
acl='python3 validate/acl/run_kernel_acl.py'
lacp='python3 validate/lacp/run_kernel_lacp.py'
nat='python3 validate/nat/run_kernel_nat.py'
span='python3 validate/span/run_kernel_span.py'
ipv6='python3 validate/ipv6/run_kernel_ipv6.py'
vrrp='python3 validate/vrrp/run_kernel_vrrp.py'
ripng='python3 validate/ripng/run_kernel_ripng.py'
full='set -e; python3 tools/build_web.py --check; (cd poc/storm-math && python3 -m pytest -q); python3 -m pytest -q tests; (cd engine && npm test); (cd cli && npm test); '"$l3"'; '"$l2"'; '"$links"'; '"$dhcp"'; '"$tcp"'; '"$cli"'; '"$intervlan"'; '"$ospf"'; '"$lldp"'; '"$aging"'; '"$rip"'; '"$tcn"'; '"$acl"'; '"$lacp"'; '"$nat"'; '"$span"'; '"$ipv6"'; '"$services"'; '"$vrrp"'; '"$ripng"'; ('"$storm"')'

case "${1:-all}" in
  l3)    cmd="$l3" ;;
  l2)    cmd="$l2" ;;
  storm) cmd="$storm" ;;
  links) cmd="$links" ;;
  dhcp)  cmd="$dhcp" ;;
  tcp)   cmd="$tcp" ;;
  services) cmd="$services" ;;
  ripng) cmd="$ripng" ;;
  cli)   cmd="$cli" ;;
  intervlan) cmd="$intervlan" ;;
  ospf)  cmd="$ospf" ;;
  lldp)  cmd="$lldp" ;;
  aging) cmd="$aging" ;;
  rip)   cmd="$rip" ;;
  bgp)   cmd="$bgp" ;;
  tcn)   cmd="$tcn" ;;
  acl)   cmd="$acl" ;;
  lacp)  cmd="$lacp" ;;
  nat)   cmd="$nat" ;;
  span)  cmd="$span" ;;
  ipv6)  cmd="$ipv6" ;;
  ripng) cmd="$ripng" ;;
  vrrp)  cmd="$vrrp" ;;
  all)   cmd="set -e; $l3; $l2; $links; $dhcp; $tcp; $cli; $intervlan; $ospf; $lldp; $aging; $rip; $bgp; $tcn; $acl; $lacp; $nat; $span; $ipv6; $services; $vrrp; $ripng; ($storm)" ;;
  full)  cmd="$full" ;;
  --)    shift; cmd="$*" ;;
  *)     echo "usage: $0 [l3|l2|links|dhcp|tcp|cli|intervlan|ospf|lldp|aging|rip|bgp|tcn|acl|lacp|nat|span|services|vrrp|ripng|storm|all|full|-- CMD...]" >&2; exit 2 ;;
esac

# --privileged: namespaces, veth, bridges, qdiscs and sysctls need CAP_SYS_ADMIN/CAP_NET_ADMIN.
# --rm: nothing persists; every run starts clean. PYTHONDONTWRITEBYTECODE keeps root-owned
# __pycache__ files out of the bind-mounted checkout.
exec docker run --rm --privileged -e PYTHONDONTWRITEBYTECODE=1 -e GITHUB_ACTIONS -e OSPF_RENDER -e RIP_RENDER \
  -v "$ROOT":/repo -w /repo "$IMAGE" bash -c "$cmd"
