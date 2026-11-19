# Deployment

Production runs at https://testing.tuetran.dev.

| Part | Runs on |
|---|---|
| Database | Supabase (transaction pooler for the apps, session pooler for migrations) |
| Artifacts | Cloudflare R2, bucket `vibe-testing-artifacts` |
| Web, API | Cloudflare Containers behind `apps/edge`. Only web is public; it reaches the API at `http://api.internal` |
| Queues | Valkey (Redis) on the worker server, in the same compose project. The worker uses the plain port on the compose network; the API comes in over TLS on port 6380 |
| Worker, runner | Docker on the worker server, `/opt/vibe-testing` (`infra/compose/docker-compose.prod.yml`) |

## Continuous deployment

`.github/workflows/deploy.yml` runs on every push to `main`, in this order: database migrations, worker server,
Cloudflare, then a check of `/healthz`. It can also be started by hand from the Actions tab.

CI does not run the tests, so nothing stops a broken commit from deploying. Run them locally before pushing, with
`pnpm infra:up` first: `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm test:e2e`.

Migrations run first, so each one must work with the previous version of the code still running.

## First-time setup

1. Copy `.env.production.example` to `.env.production` and fill it in.
2. Prepare the server. The first command creates the `deploy` user; the second changes a host-wide kernel setting that
   Chromium's sandbox needs (`infra/seccomp/README.md`):
   `scripts/deploy/bootstrap-server.sh root@204.168.174.158`
   `scripts/deploy/enable-chromium-sandbox.sh root@204.168.174.158`
3. Load the settings into GitHub: `scripts/deploy/set-github-secrets.sh 204.168.174.158`. The first run also sets up
   Valkey: the `api` and `worker` passwords, a private CA and a TLS certificate for that IP, and `REDIS_URL`
   (`rediss://api:…@204.168.174.158:6380`, the API's; the deploy writes the worker's own). Leave `REDIS_URL` empty in
   `.env.production`: the script overwrites it.
   Open TCP 6380 in the server's firewall or provider's security group (Cloudflare Containers have no fixed egress IPs,
   so it cannot be limited by source: TLS, the ACL password and the blocked commands protect it).
4. Merge to `main`, or start the Deploy workflow by hand.

**Valkey.** The deploy writes `/opt/vibe-testing/valkey/` (the ACL with SHA-256 password hashes, the certificate and
its key) and the `valkey-data` volume keeps the append-only file, so queued jobs survive a restart. Both users can run
everything but the `@dangerous` commands (`FLUSHALL`, `CONFIG`, `KEYS`, `DEBUG`, …), except `INFO`, which BullMQ
needs. It is capped at 256 MB with `noeviction`: when it is full, writes fail instead of jobs being dropped. Only the
API trusts the CA (`REDIS_TLS_CA`); the certificate is valid for 10 years. To rotate it, or a password, delete the
`REDIS_TLS_*` lines (or the password line) from `.env.production` and do step 3 and a deploy again.

Keep `.env.production` somewhere safe. Replacing `SECRETS_ENCRYPTION_KEY` makes stored secrets unreadable; to change
it, follow the key rotation steps in `docs/operations.md`.

To change a setting, edit `.env.production`, run step 3 again, and re-run the Deploy workflow.
