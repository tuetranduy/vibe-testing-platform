# Deployment

Production runs at https://testing.tuetran.dev.

| Part | Runs on |
|---|---|
| Database | Supabase (transaction pooler for the apps, session pooler for migrations) |
| Artifacts | Cloudflare R2, bucket `vibe-testing-artifacts` |
| Web, API | Cloudflare Containers behind `apps/edge`. Only web is public; it reaches the API at `http://api.internal` |
| Queues | Managed Redis |
| Worker, runner | Docker on the worker server, `/opt/vibe-testing` (`infra/compose/docker-compose.prod.yml`) |

## Continuous deployment

`.github/workflows/deploy.yml` runs after CI passes on a push to `main`, in this order: database migrations, worker
server, Cloudflare, then a check of `/healthz`. It can also be started by hand from the Actions tab. A failed CI run
deploys nothing.

Migrations run first, so each one must work with the previous version of the code still running.

## First-time setup

1. Copy `.env.production.example` to `.env.production` and fill it in.
2. Prepare the server. The first command creates the `deploy` user; the second changes a host-wide kernel setting that
   Chromium's sandbox needs (`infra/seccomp/README.md`):
   `scripts/deploy/bootstrap-server.sh root@204.168.174.158`
   `scripts/deploy/enable-chromium-sandbox.sh root@204.168.174.158`
3. Load the settings into GitHub: `scripts/deploy/set-github-secrets.sh 204.168.174.158`
4. Merge to `main`, or start the Deploy workflow by hand.

Keep `.env.production` somewhere safe. Replacing `SECRETS_ENCRYPTION_KEY` makes stored secrets unreadable; to change
it, follow the key rotation steps in `docs/operations.md`.

To change a setting, edit `.env.production`, run step 3 again, and re-run the Deploy workflow.
