#!/usr/bin/env bash
# Run by .github/workflows/deploy.yml: rolls the worker server to the image for $SHA.
set -euo pipefail

umask 077
key=$(mktemp)
hosts=$(mktemp)
envfile=$(mktemp)
trap 'rm -f "$key" "$hosts" "$envfile"' EXIT
printf '%s\n' "$SSH_KEY" >"$key"
printf '%s\n' "$KNOWN_HOSTS" >"$hosts"

ssh_opts=(-i "$key" -o UserKnownHostsFile="$hosts" -o StrictHostKeyChecking=yes -o BatchMode=yes)
target="deploy@$HOST"
image="$WORKER_IMAGE_NAME:$SHA"

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
EOF
  for name in DATABASE_URL REDIS_URL S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY API_TOKEN SECRETS_ENCRYPTION_KEY \
    RUNNER_TOKEN LLM_PROVIDER LLM_MODEL ANTHROPIC_API_KEY GEMINI_API_KEY DEEPSEEK_API_KEY; do
    if [ -n "${!name:-}" ]; then printf '%s=%s\n' "$name" "${!name}"; fi
  done
} >"$envfile"

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
  docker compose pull
  docker compose up -d --wait --remove-orphans
  # Only this app\x27s older images: the server is shared and short of disk.
  docker images --format \"{{.Repository}}:{{.Tag}}\" \"$WORKER_IMAGE_NAME\" | grep -v \":$SHA\$\" | xargs -r docker rmi || true
'"
