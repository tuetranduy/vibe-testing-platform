#!/usr/bin/env bash
# Loads production settings into GitHub. Run on your own machine after bootstrap-server.sh:
#   scripts/deploy/set-github-secrets.sh 204.168.174.158
# Reads .env.production (see docs/deployment.md). Generates API_TOKEN, RUNNER_TOKEN and SECRETS_ENCRYPTION_KEY there
# the first time; keep that file, because a new SECRETS_ENCRYPTION_KEY cannot decrypt secrets already stored.
# It also sets up Valkey (Redis) on the server the first time: the API and worker passwords, a private CA and the
# server's TLS certificate for <server-ip>, and REDIS_URL (the API's URL; the worker's is written by the deploy).
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
generate REDIS_API_PASSWORD 'openssl rand -hex 32'
generate REDIS_WORKER_PASSWORD 'openssl rand -hex 32'

# Valkey's TLS: a CA that only the API trusts (REDIS_TLS_CA) and a 10-year server certificate for the host. The CA key
# is thrown away; to rotate, delete the three REDIS_TLS_* lines and run this again.
if ! grep -q '^REDIS_TLS_CA=.' "$file"; then
  tls=$(mktemp -d)
  trap 'rm -rf "$tls"' EXIT
  if [[ $host =~ ^[0-9.]+$ || $host == *:* ]]; then san="IP:$host"; else san="DNS:$host"; fi
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 -subj "/CN=vibe-testing valkey CA" \
    -keyout "$tls/ca.key" -out "$tls/ca.crt" 2>/dev/null
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=$host" \
    -keyout "$tls/server.key" -out "$tls/server.csr" 2>/dev/null
  printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\n' "$san" >"$tls/ext"
  openssl x509 -req -in "$tls/server.csr" -CA "$tls/ca.crt" -CAkey "$tls/ca.key" -CAcreateserial -days 3650 \
    -extfile "$tls/ext" -out "$tls/server.crt" 2>/dev/null
  b64() { openssl base64 -A <"$1"; }
  sed -E -i.bak '/^REDIS_TLS_(CA|CERT|KEY)=/d' "$file" && rm -f "$file.bak"
  printf 'REDIS_TLS_CA=%s\nREDIS_TLS_CERT=%s\nREDIS_TLS_KEY=%s\n' "$(b64 "$tls/ca.crt")" "$(b64 "$tls/server.crt")" \
    "$(b64 "$tls/server.key")" >>"$file"
fi
api_password=$(grep '^REDIS_API_PASSWORD=' "$file" | cut -d= -f2-)
sed -i.bak '/^REDIS_URL=/d' "$file" && rm -f "$file.bak"
printf 'REDIS_URL=rediss://api:%s@%s:6380\n' "$api_password" "$host" >>"$file"

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
