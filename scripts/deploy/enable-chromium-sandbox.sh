#!/usr/bin/env bash
# Run once by the server's owner:  scripts/deploy/enable-chromium-sandbox.sh root@204.168.174.158
# Chromium's sandbox needs unprivileged user namespaces, which Ubuntu 24.04's AppArmor restricts (infra/seccomp/README.md).
# This is a host-wide security setting: it applies to everything on the server.
set -euo pipefail

server=${1:?usage: enable-chromium-sandbox.sh root@host}
ssh "$server" "echo 'kernel.apparmor_restrict_unprivileged_userns=0' >/etc/sysctl.d/60-chromium-userns.conf && sysctl -p /etc/sysctl.d/60-chromium-userns.conf"
