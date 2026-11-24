#!/usr/bin/env bash
# One-time local development setup: `pnpm dev:setup` (or `bash scripts/dev-setup.sh`) on a fresh clone.
#
#   1. checks Node (>= engines.node), pnpm (packageManager's major version), Docker and Docker Compose v2
#   2. installs dependencies (pnpm install --frozen-lockfile)
#   3. creates .env from .env.example with a freshly generated SECRETS_ENCRYPTION_KEY (an existing .env is kept)
#   4. installs Playwright's Chromium for the real engine's browser sandbox (skipped when already installed)
#   5. starts postgres, redis, s3 and demo-shop (pnpm infra:up)
#   6. applies the database migrations and seeds the default tenant (pnpm db:migrate)
#   7. sets up Browser Use discovery (apps/browser-use-discovery): uv sync, the agent image, discovery.env (scripted
#      model: no key, no cost) and the BROWSER_USE_DISCOVERY_* keys in .env. Needs uv (brew install uv).
#
# Safe to re-run: every step checks before it acts. The only change ever made to an existing .env is step 7 adding its
# Browser Use keys once (when no discovery transport is set), after copying .env to .env.backup-<time>.
# The first administrator is created by the API at its first start (BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD).
#
# Options: --skip-browser (no Playwright Chromium), --skip-browser-use (no step 7),
#          --skip-infra (no Docker: also skips the migrations and Browser Use), -h | --help.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SKIP_BROWSER=0
SKIP_BROWSER_USE=0
SKIP_INFRA=0
for arg in "$@"; do
  case "$arg" in
    --skip-browser) SKIP_BROWSER=1 ;;
    --skip-browser-use) SKIP_BROWSER_USE=1 ;;
    --skip-infra) SKIP_INFRA=1 ;;
    -h | --help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option: $arg (see --help)" >&2
      exit 2
      ;;
  esac
done

if [ -t 1 ]; then
  BOLD=$'\033[1m' GREEN=$'\033[32m' YELLOW=$'\033[33m' RED=$'\033[31m' RESET=$'\033[0m'
else
  BOLD="" GREEN="" YELLOW="" RED="" RESET=""
fi
step() { printf '\n%s==> %s%s\n' "$BOLD" "$1" "$RESET"; }
ok() { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
die() {
  printf '  %s✗ %s%s\n' "$RED" "$1" "$RESET" >&2
  exit 1
}

# Compares dotted versions: succeeds when $1 >= $2.
version_ge() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n | head -n1)" = "$2" ]
}

# Prints KEY's value from an env file (last uncommented assignment, surrounding quotes removed), or nothing.
env_value() {
  local key="$1" file="$2" line
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" | tail -n1 || true)"
  line="${line#*=}"
  line="${line%\"}" && line="${line#\"}"
  line="${line%\'}" && line="${line#\'}"
  printf '%s' "$line"
}

# --- 1. Prerequisites ------------------------------------------------------------------------------------------------
step "Checking prerequisites"

command -v node >/dev/null 2>&1 || die "Node.js is not installed. Install Node >= 22.18 (e.g. nvm install 22)."
NODE_REQUIRED="$(node -p "(require('./package.json').engines?.node ?? '').replace(/^>=\s*/, '')")"
NODE_VERSION="$(node -p 'process.versions.node')"
if [ -n "$NODE_REQUIRED" ] && ! version_ge "$NODE_VERSION" "$NODE_REQUIRED"; then
  die "Node $NODE_VERSION is too old; this repo needs >= $NODE_REQUIRED (e.g. nvm install 22)."
fi
ok "Node $NODE_VERSION (needs >= ${NODE_REQUIRED:-any})"

PNPM_WANTED="$(node -p "(require('./package.json').packageManager ?? '').replace(/^pnpm@/, '')")"
if ! command -v pnpm >/dev/null 2>&1; then
  die "pnpm is not installed. Run \`corepack enable\` (ships with Node), then re-run this script."
fi
PNPM_VERSION="$(pnpm --version)"
if [ -n "$PNPM_WANTED" ] && [ "${PNPM_VERSION%%.*}" != "${PNPM_WANTED%%.*}" ]; then
  die "pnpm $PNPM_VERSION found; this repo pins pnpm@$PNPM_WANTED. Run \`corepack enable\` and re-run."
fi
ok "pnpm $PNPM_VERSION (pinned: ${PNPM_WANTED:-none})"

if [ "$SKIP_INFRA" -eq 0 ]; then
  command -v docker >/dev/null 2>&1 || die "Docker is not installed. Install Docker Desktop (or pass --skip-infra)."
  docker info >/dev/null 2>&1 || die "Docker is installed but its daemon is not running. Start Docker Desktop and re-run."
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 (\`docker compose\`) is missing. Update Docker Desktop."
  ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null), Compose $(docker compose version --short)"
else
  warn "Docker checks skipped (--skip-infra)"
fi

# --- 2. Dependencies -------------------------------------------------------------------------------------------------
step "Installing dependencies"
# CI=true: without a TTY, pnpm aborts instead of asking before it recreates node_modules
# (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY). With nothing to change this is a quick no-op.
CI=true pnpm install --frozen-lockfile --reporter=append-only | sed 's/^/  /'
ok "dependencies match pnpm-lock.yaml"

# --- 3. Local env file -----------------------------------------------------------------------------------------------
step "Preparing .env"
PLACEHOLDER_KEY="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
ENV_CREATED=0
if [ -f .env ]; then
  ok ".env exists; left unchanged"
  if [ "$(env_value SECRETS_ENCRYPTION_KEY .env)" = "$PLACEHOLDER_KEY" ]; then
    warn ".env still has the example SECRETS_ENCRYPTION_KEY. Fine for local use; replacing it makes provider keys"
    warn "saved in Settings unreadable (save them again). Generate one with:"
    warn "  node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
  fi
  # Keys the example sets that .env lacks (most have defaults; listed so new settings aren't missed).
  missing=()
  while IFS= read -r key; do
    grep -qE "^[[:space:]]*(export[[:space:]]+)?${key}=" .env || missing+=("$key")
  done < <(grep -E '^[A-Z0-9_]+=' .env.example | cut -d= -f1)
  if [ "${#missing[@]}" -gt 0 ]; then
    warn ".env lacks keys that .env.example sets (compare the two if something misbehaves): ${missing[*]}"
  fi
else
  KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"
  tmp="$(mktemp "$ROOT/.env.XXXXXX")"
  # The key is base64 (A-Z a-z 0-9 + / =): '|' can't appear in it.
  sed "s|^SECRETS_ENCRYPTION_KEY=.*|SECRETS_ENCRYPTION_KEY=$KEY|" .env.example >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" .env
  ENV_CREATED=1
  ok "created .env from .env.example with a generated SECRETS_ENCRYPTION_KEY (fake LLM provider; edit to taste)"
fi

# --- 4. Playwright Chromium ------------------------------------------------------------------------------------------
step "Installing Playwright's Chromium"
if [ "$SKIP_BROWSER" -eq 1 ]; then
  warn "skipped (--skip-browser); the real engine and pnpm test:integration / test:e2e need it"
else
  # Downloads only when this playwright-core version's Chromium is missing.
  pnpm --filter @platform/worker exec playwright-core install chromium | sed 's/^/  /'
  ok "Chromium for playwright-core $(pnpm --filter @platform/worker exec playwright-core --version | awk '{print $2}')"
fi

# --- 5. Infrastructure -----------------------------------------------------------------------------------------------
step "Starting postgres, redis, s3 and demo-shop"
if [ "$SKIP_INFRA" -eq 1 ]; then
  warn "skipped (--skip-infra); run pnpm infra:up and pnpm db:migrate once Docker is available"
else
  pnpm --silent infra:up 2>&1 | sed 's/^/  /'
  ok "infra is healthy"
fi

# --- 6. Database ------------------------------------------------------------------------------------------------------
step "Applying database migrations"
if [ "$SKIP_INFRA" -eq 1 ]; then
  warn "skipped (--skip-infra)"
else
  DATABASE_URL="$(env_value DATABASE_URL .env)"
  [ -n "$DATABASE_URL" ] || die ".env has no DATABASE_URL"
  DEFAULT_TENANT_ID="$(env_value DEFAULT_TENANT_ID .env)"
  # Only the two values migrate.ts reads: .env itself is never sourced here.
  DATABASE_URL="$DATABASE_URL" DEFAULT_TENANT_ID="${DEFAULT_TENANT_ID:-t_default}" pnpm --silent db:migrate | sed 's/^/  /'
  ok "database up to date"
fi

# --- 7. Browser Use discovery ----------------------------------------------------------------------------------------
step "Setting up Browser Use discovery"
BU_DIR="$ROOT/apps/browser-use-discovery"
BU_READY=0
BU_CHANGED=0
if [ "$SKIP_BROWSER_USE" -eq 1 ] || [ "$SKIP_INFRA" -eq 1 ]; then
  warn "skipped ($([ "$SKIP_INFRA" -eq 1 ] && echo --skip-infra || echo --skip-browser-use))"
elif ! command -v uv >/dev/null 2>&1; then
  warn "uv is not installed, so Browser Use discovery is not set up. Install it (brew install uv, or"
  warn "https://docs.astral.sh/uv/) and re-run, or pass --skip-browser-use to silence this."
else
  # The host venv: the launcher, the model broker and the fixture server. uv fetches Python 3.12 if needed.
  (cd "$BU_DIR" && uv sync --frozen --quiet)
  ok "Python venv in sync with uv.lock ($("$BU_DIR/.venv/bin/python" --version))"

  # The launcher runs with PATH only (the worker strips the environment), so its config lives in this file.
  if [ -f "$BU_DIR/discovery.env" ]; then
    ok "apps/browser-use-discovery/discovery.env exists; left unchanged"
  else
    cp "$BU_DIR/discovery.env.example" "$BU_DIR/discovery.env"
    if ! env -i PATH="$PATH" docker info >/dev/null 2>&1; then
      # Without HOME this Docker CLI can't find its socket: name it (Docker Desktop on macOS).
      printf '\nDOCKER_HOST=%s\n' "$(docker context inspect --format '{{.Endpoints.docker.Host}}')" >>"$BU_DIR/discovery.env"
    fi
    BU_CHANGED=1
    ok "created apps/browser-use-discovery/discovery.env (DISCOVERY_MODEL=scripted: no key, no cost)"
  fi

  # The agent image, rebuilt only when its build inputs change (their hash is a label on the image).
  BU_IMAGE="$(env_value DISCOVERY_IMAGE "$BU_DIR/discovery.env")"
  BU_IMAGE="${BU_IMAGE:-vtp-browser-use-discovery:1.0.6}"
  BU_HASH="$(cd "$BU_DIR" && find Dockerfile requirements.lock fixture/site image-bin src -type f \
    -not -path '*/__pycache__/*' -not -name '*.pyc' | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | cut -c1-16)"
  BU_BUILT="$(docker image inspect --format '{{ index .Config.Labels "vtp.dev-setup.inputs" }}' "$BU_IMAGE" 2>/dev/null || true)"
  if [ "$BU_BUILT" = "$BU_HASH" ]; then
    ok "agent image $BU_IMAGE is current"
  else
    echo "  building $BU_IMAGE (a few minutes the first time: Chromium and Browser Use)…"
    docker build --quiet --label "vtp.dev-setup.inputs=$BU_HASH" -t "$BU_IMAGE" "$BU_DIR" >/dev/null
    BU_CHANGED=1
    ok "built agent image $BU_IMAGE"
  fi

  # .env: admission (API and worker) and the one-shot launcher transport (worker).
  BU_FIXTURE_URL="$(env_value DISCOVERY_FIXTURE_URL "$BU_DIR/discovery.env")"
  BU_FIXTURE_URL="${BU_FIXTURE_URL:-http://127.0.0.1:4599/}"
  BU_FIXTURE_HOST="$(node -p 'new URL(process.argv[1]).host' "$BU_FIXTURE_URL")"
  if [ -n "$(env_value BROWSER_USE_DISCOVERY_LAUNCHER .env)$(env_value BROWSER_USE_DISCOVERY_SERVICE_URL .env)" ]; then
    ok ".env already has a Browser Use transport; left unchanged"
  else
    if [ "$ENV_CREATED" -eq 0 ]; then
      backup=".env.backup-$(date +%Y%m%d%H%M%S)"
      cp -p .env "$backup"
      ok "backed up .env to $backup"
    fi
    # Allow the host fixture as a private target: append it to TARGET_PRIVATE_ALLOWLIST (or add the line).
    node - "$BU_FIXTURE_HOST" <<'JS'
const fs = require("fs");
const host = process.argv[2];
let text = fs.readFileSync(".env", "utf8");
const re = /^(TARGET_PRIVATE_ALLOWLIST=)(.*)$/m;
const match = text.match(re);
if (!match) text += `${text.endsWith("\n") ? "" : "\n"}TARGET_PRIVATE_ALLOWLIST=${host}\n`;
else if (!match[2].split(",").map((s) => s.trim()).includes(host)) {
  text = text.replace(re, (_, k, v) => `${k}${v.trim() ? `${v.trim()},` : ""}${host}`);
}
fs.writeFileSync(".env", text);
JS
    cat >>.env <<EOF

# --- Browser Use discovery (local pilot; added by scripts/dev-setup.sh, see apps/browser-use-discovery/README.md) ---
# Admission (API and worker): the bundled fixture, served on the host by apps/browser-use-discovery/bin/serve-fixture.
BROWSER_USE_DISCOVERY_FIXTURE_URL=$BU_FIXTURE_URL
# Live public HTTPS sites too: the worker reads a few same-origin pages and gives the agent an inert copy.
BROWSER_USE_DISCOVERY_VERIFIED_SITES=on
# Transport (worker only): the one-shot launcher, configured by apps/browser-use-discovery/discovery.env.
BROWSER_USE_DISCOVERY_LAUNCHER=$BU_DIR/bin/browser-use-discovery
EOF
    BU_CHANGED=1
    ok "added the Browser Use keys to .env and $BU_FIXTURE_HOST to TARGET_PRIVATE_ALLOWLIST"
  fi

  # The launcher end to end (scripted model, the real agent container), after any change: proves venv, image,
  # Docker and config. About a minute, so a run that changed nothing skips it.
  if [ "$BU_CHANGED" -eq 0 ]; then
    ok "nothing changed since the last setup; launcher smoke run skipped"
    BU_READY=1
  else
    echo "  launcher smoke run (scripted model, real agent container; about a minute)…"
    BU_REPLY="$(printf '{"schemaVersion":"discovery.v1","runId":"dev-setup","targetUrl":"%s","timeoutSeconds":90}\n' "$BU_FIXTURE_URL" |
      env -i PATH="$PATH" "$BU_DIR/bin/browser-use-discovery" 2>/dev/null || true)"
    BU_STATUS="$(printf '%s' "$BU_REPLY" | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{try{const r=JSON.parse(s);console.log(`${r.status}/${r.reason}`)}catch{console.log("no reply")}})')"
    if [ "${BU_STATUS%%/*}" = "COMPLETED" ]; then
      ok "launcher smoke run: $BU_STATUS"
      BU_READY=1
    else
      warn "launcher smoke run answered $BU_STATUS; try it by hand (see apps/browser-use-discovery/README.md, Setup)"
    fi
  fi
fi

# --- Done ------------------------------------------------------------------------------------------------------------
step "Local stack ready"
if [ "$SKIP_INFRA" -eq 0 ] && docker compose -f infra/compose/docker-compose.yml ps --status running --services 2>/dev/null | grep -qx api; then
  warn "the full compose stack (pnpm stack:up) is running: its api holds port 3001 and its worker takes jobs."
  warn "Stop them before running your own: docker compose -f infra/compose/docker-compose.yml stop api worker web"
fi
cat <<'EOF'
  The apps don't read .env themselves. In each terminal:
    set -a; . ./.env; set +a
    pnpm --filter @platform/api dev       # http://localhost:3001
    pnpm --filter @platform/worker dev
    pnpm --filter @platform/web dev       # http://localhost:3000 (sign in with BOOTSTRAP_ADMIN_* from .env)
EOF
if [ "$BU_READY" -eq 1 ]; then
  cat <<EOF
  Browser Use discovery, in one more terminal:
    apps/browser-use-discovery/bin/serve-fixture --port ${BU_FIXTURE_HOST##*:}   # the fixture at $BU_FIXTURE_URL
  then, as the administrator: Settings → Browser Use fixture pilot → Enable Browser Use. In New test, enter
  $BU_FIXTURE_URL (or a public HTTPS site), choose a real survey model, Find test ideas, and check
  Autonomous Discovery (Browser Use).
EOF
fi
echo "  Tests: pnpm typecheck && pnpm test"
