#!/usr/bin/env bash
# Run by .github/workflows/deploy.yml: rolls the worker server to the image for $SHA.
set -euo pipefail

umask 077
key=$(mktemp)
hosts=$(mktemp)
envfile=$(mktemp)
valkey=$(mktemp -d)
trap 'rm -rf "$key" "$hosts" "$envfile" "$valkey"' EXIT
printf '%s\n' "$SSH_KEY" >"$key"
printf '%s\n' "$KNOWN_HOSTS" >"$hosts"

ssh_opts=(-i "$key" -o UserKnownHostsFile="$hosts" -o StrictHostKeyChecking=yes -o BatchMode=yes)
target="deploy@$HOST"
image="$WORKER_IMAGE_NAME:$SHA"
agent_image="$BROWSER_USE_AGENT_IMAGE_NAME:$SHA"
broker_image="$BROWSER_USE_BROKER_IMAGE_NAME:$SHA"
# A fresh signing token per deploy: only the worker and the job service, both restarted below, ever hold it.
discovery_token=$(openssl rand -hex 32)
for name in REDIS_API_PASSWORD REDIS_WORKER_PASSWORD REDIS_TLS_CERT REDIS_TLS_KEY; do
  [ -n "${!name:-}" ] || { echo "$name is not set: run scripts/deploy/set-github-secrets.sh" >&2; exit 1; }
done

{
  cat <<EOF
NODE_ENV=production
BROWSER_MODE=local
DEFAULT_TENANT_ID=t_default
RUN_MIGRATIONS_ON_START=false
ARTIFACT_STORAGE_TYPE=s3
ARTIFACT_BUCKET=vibe-testing-artifacts
S3_ENDPOINT=https://0aa33be34354cada10bebf66ea994e23.r2.cloudflarestorage.com
S3_REGION=auto
S3_FORCE_PATH_STYLE=true
# One browser at a time: this server has 2 vCPUs and 3.7 GB shared with other apps.
WORKER_CONCURRENCY=1
LOG_LEVEL=info
WORKER_IMAGE=$image
# Valkey on this server, over the compose network (docker-compose.prod.yml). The API's REDIS_URL is the TLS port.
REDIS_URL=redis://worker:$REDIS_WORKER_PASSWORD@valkey:6379
# Browser Use fixture pilot: images and the job service's settings (docker-compose.prod.yml).
BROWSER_USE_AGENT_IMAGE=$agent_image
BROWSER_USE_BROKER_IMAGE=$broker_image
BROWSER_USE_DISCOVERY_MODEL=${BROWSER_USE_DISCOVERY_MODEL:-deepseek:deepseek-flash}
BROWSER_USE_DISCOVERY_SERVICE_TOKEN=$discovery_token
BROWSER_USE_DISCOVERY_CAPACITY=${BROWSER_USE_DISCOVERY_CAPACITY:-1}
EOF
  # The worker's side of the pilot. BROWSER_USE_DISCOVERY=off (a repository variable) leaves the worker without it on
  # the next deploy: opted-in runs then record BLOCKED / not_configured and get standard suggestions.
  if [ "${BROWSER_USE_DISCOVERY:-on}" != "off" ]; then
    cat <<EOF
BROWSER_USE_DISCOVERY_PRODUCTION=fixture-pilot
BROWSER_USE_DISCOVERY_FIXTURE_URL=http://browser-use-fixture:4599/
BROWSER_USE_DISCOVERY_VERIFIED_SITES=${BROWSER_USE_DISCOVERY_VERIFIED_SITES:-on}
BROWSER_USE_DISCOVERY_LIVE_INTERACTION=${BROWSER_USE_DISCOVERY_LIVE_INTERACTION:-on}
BROWSER_USE_DISCOVERY_TENANTS=t_default
BROWSER_USE_DISCOVERY_SERVICE_URL=http://browser-use-discovery:4600
TARGET_PRIVATE_ALLOWLIST=browser-use-fixture:4599
EOF
  fi
  for name in DATABASE_URL S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY API_TOKEN SECRETS_ENCRYPTION_KEY \
    RUNNER_TOKEN LLM_PROVIDER LLM_MODEL ANTHROPIC_API_KEY GEMINI_API_KEY DEEPSEEK_API_KEY; do
    if [ -n "${!name:-}" ]; then printf '%s=%s\n' "$name" "${!name}"; fi
  done
} >"$envfile"

# Valkey's users: passwords as SHA-256 only, the default user off, and no command that reconfigures the server or
# wipes or lists every key (INFO stays: BullMQ reads the server version from it).
sha() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
rules='~* &* +@all -@dangerous +info'
{
  echo "user default off"
  echo "user api on #$(sha "$REDIS_API_PASSWORD") $rules"
  echo "user worker on #$(sha "$REDIS_WORKER_PASSWORD") $rules"
} >"$valkey/users.acl"
printf '%s' "$REDIS_TLS_CERT" | base64 -d >"$valkey/server.crt"
printf '%s' "$REDIS_TLS_KEY" | base64 -d >"$valkey/server.key"

ssh "${ssh_opts[@]}" "$target" 'install -d -m 700 /opt/vibe-testing/valkey'
scp "${ssh_opts[@]}" "$valkey/users.acl" "$valkey/server.crt" "$valkey/server.key" "$target:/opt/vibe-testing/valkey/"
scp "${ssh_opts[@]}" infra/compose/docker-compose.prod.yml "$target:/opt/vibe-testing/docker-compose.yml"
scp "${ssh_opts[@]}" infra/seccomp/worker.json "$target:/opt/vibe-testing/worker.json"
scp "${ssh_opts[@]}" "$envfile" "$target:/opt/vibe-testing/.env"

# The registry token goes over stdin and the login is removed afterwards.
printf '%s' "$GHCR_TOKEN" | ssh "${ssh_opts[@]}" "$target" bash -c "'
  set -euo pipefail
  cd /opt/vibe-testing
  chmod 600 .env
  docker login ghcr.io -u deploy --password-stdin
  trap \"docker logout ghcr.io\" EXIT
  # The server is shared and short of disk: drop this app\x27s superseded images that no container uses before
  # pulling, and never recreate containers on a nearly full disk (they then fail to start, ENOSPC: 2026-11-24).
  for name in \"$WORKER_IMAGE_NAME\" \"$BROWSER_USE_AGENT_IMAGE_NAME\" \"$BROWSER_USE_BROKER_IMAGE_NAME\"; do
    for img in \$(docker images --format \"{{.Repository}}:{{.Tag}}\" \"\$name\" | grep -v \":$SHA\$\"); do
      [ -n \"\$(docker ps -aq --filter ancestor=\$img)\" ] || docker rmi \"\$img\" || true
    done
  done
  docker compose pull
  avail=\$(df -Pk /var/lib/docker | tail -1 | tr -s \" \" | cut -d\" \" -f4)
  if [ \"\$avail\" -lt 1572864 ]; then
    echo \"Only \$((avail / 1024)) MB free after pulling: not recreating containers. Free disk and re-run the deploy.\" >&2
    exit 1
  fi
  docker compose up -d --wait --remove-orphans
  # Only this app\x27s older images: the server is shared and short of disk.
  for name in \"$WORKER_IMAGE_NAME\" \"$BROWSER_USE_AGENT_IMAGE_NAME\" \"$BROWSER_USE_BROKER_IMAGE_NAME\"; do
    docker images --format \"{{.Repository}}:{{.Tag}}\" \"\$name\" | grep -v \":$SHA\$\" | xargs -r docker rmi || true
  done
'"
