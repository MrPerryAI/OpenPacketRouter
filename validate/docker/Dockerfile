# Linux box for the root/namespace validations (OpenPacketRouter engine vs real Linux).
# Build and run from the repo root with validate/docker/run.sh (see docs/docker-validation.md).
# The repo is bind-mounted at /repo, so the image only holds tools, not code.
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 python3-numpy python3-pytest python3-jsonschema iproute2 util-linux procps kmod tcpdump ca-certificates dnsmasq-base busybox frr nftables lldpd conntrack keepalived iputils-ping \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
CMD ["bash"]
