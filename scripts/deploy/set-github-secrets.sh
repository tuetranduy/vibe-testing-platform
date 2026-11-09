#!/usr/bin/env bash
# Loads production settings into GitHub. Run on your own machine after bootstrap-server.sh:
#   scripts/deploy/set-github-secrets.sh 204.168.174.158
# Reads .env.production (see docs/deployment.md). Generates API_TOKEN, RUNNER_TOKEN and SECRETS_ENCRYPTION_KEY there
# the first time; keep that file, because a new SECRETS_ENCRYPTION_KEY cannot decrypt secrets already stored.
set -euo pipefail

host=${1:?usage: set-github-secrets.sh <server-ip>}
file=.env.production
key=${DEPLOY_KEY_DIR:-$HOME/.ssh}/vibe-testing-deploy
[ -f "$file" ] || { echo "$file not found" >&2; exit 1; }
[ -f "$key" ] || { echo "run bootstrap-server.sh first" >&2; exit 1; }
chmod 600 "$file"

generate() { # name, command
  grep -q "^$1=." "$file" || printf '%s=%s\n' "$1" "$(eval "$2")" >>"$file"
}
generate API_TOKEN 'openssl rand -hex 32'
generate RUNNER_TOKEN 'openssl rand -hex 32'
generate SECRETS_ENCRYPTION_KEY 'openssl rand -base64 32'

gh api -X PUT "repos/{owner}/{repo}/environments/production" --silent
gh secret set --env production --env-file <(grep -v '^LLM_' "$file" | grep -E '^[A-Z0-9_]+=.')
gh secret set DEPLOY_SSH_KEY --env production <"$key"
gh secret set DEPLOY_HOST --env production --body "$host"
gh secret set DEPLOY_KNOWN_HOSTS --env production --body "$(ssh-keyscan -t ed25519 "$host" 2>/dev/null)"

# Optional: without them the deploy starts with anthropic as a placeholder, and the app's Settings choose the model.
for name in LLM_PROVIDER LLM_MODEL; do
  value=$(grep "^$name=" "$file" | cut -d= -f2- || true)
  if [ -n "$value" ]; then gh variable set "$name" --env production --body "$value"; fi
done
echo "GitHub production environment is set."
