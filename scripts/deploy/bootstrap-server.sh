#!/usr/bin/env bash
# One-time server setup. Run on your own machine:  scripts/deploy/bootstrap-server.sh root@204.168.174.158
# It creates a `deploy` user for GitHub Actions. Then run enable-chromium-sandbox.sh for the kernel setting.
set -euo pipefail

server=${1:?usage: bootstrap-server.sh root@host}
dir=${DEPLOY_KEY_DIR:-$HOME/.ssh}
key="$dir/vibe-testing-deploy"
[ -f "$key" ] || ssh-keygen -t ed25519 -N '' -C vibe-testing-deploy -f "$key"

# %q: ssh joins its arguments into one string, and the remote shell would otherwise split the key on its spaces.
ssh "$server" bash -s -- "$(printf %q "$(cat "$key.pub")")" <<'REMOTE'
set -euo pipefail
pub=$1
id deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash deploy
usermod -aG docker deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
echo "$pub" >/home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
install -d -m 750 -o deploy -g deploy /opt/vibe-testing
REMOTE

echo "Server ready. Deploy key: $key"
