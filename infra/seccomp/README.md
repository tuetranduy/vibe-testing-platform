# Worker seccomp profile

`worker.json` is the seccomp profile of the worker container (`infra/compose/docker-compose.yml`:
`security_opt: ["seccomp=../seccomp/worker.json"]`). It lets Chromium keep its own sandbox on inside
the container, for exploration's browser and for the Playwright rerun's.

## Why

Chromium's Linux sandbox runs each renderer in new user, PID and network namespaces. Before it starts,
it checks that it can: it forks into a new user namespace with `clone(CLONE_NEWUSER)`, and the child
calls `unshare(CLONE_NEWUSER)`. Docker's default seccomp profile allows neither without
`CAP_SYS_ADMIN`, so Chromium aborts with "No usable sandbox!" and every exploring run ended
`ERRORED / BROWSER_PROVIDER` (the rerun `ERRORED`). The alternatives were worse: `cap_add: SYS_ADMIN`
grants far more than namespaces, and `--no-sandbox` would run the untrusted target site with no browser
sandbox at all.

## What differs from Docker's default

`worker.json` is Docker's default profile ([moby/profiles `seccomp/default.json`](https://github.com/moby/profiles/blob/main/seccomp/default.json),
fetched 2026-09-27) with one change, made by `derive-worker-profile.mjs`:

- `clone` may set `CLONE_NEWUSER`, `CLONE_NEWPID` and `CLONE_NEWNET` (Docker's mask `0x7E020000`
  becomes `0x0E020000`, on both the generic and the s390 rule);
- `unshare` is allowed for the same three namespaces (Docker allows it only with `CAP_SYS_ADMIN`).

Everything else is Docker's: mount, UTS, IPC and cgroup namespaces stay denied, `clone3` still answers
`ENOSYS` (glibc falls back to `clone`), `setns`, `mount` and the rest still need `CAP_SYS_ADMIN`, which
the container does not have. The container gets no extra capability.

To regenerate it (e.g. to follow a newer Docker default):

```bash
curl -fsSLo /tmp/default.json https://raw.githubusercontent.com/moby/profiles/main/seccomp/default.json
node infra/seccomp/derive-worker-profile.mjs /tmp/default.json infra/seccomp/worker.json
```

The script refuses to run if Docker's `clone` rules are no longer the two it expects.

## Verified

On Docker Desktop 29.5.3 (arm64, 2026-09-27):

- with the profile, both Chromium builds in the worker image (`chromium-1194/chrome-linux/chrome`, used by
  exploration, and `chromium_headless_shell-1194`, used by the rerun) start with their sandbox, and the
  renderers run in their own user, PID and network namespaces; `unshare --mount` and `unshare --uts`
  are still refused;
- without it (Docker's default), Chromium aborts with "No usable sandbox!";
- the E2E suite passes with the API and worker in the compose containers: `pnpm test:e2e:compose`
  (`E2E_PLATFORM=compose`); with Docker's default profile its PASS spec ends `ERRORED`.

## Hosts

The profile only lifts Docker's filter. The host kernel must still allow unprivileged user namespaces
(`user.max_user_namespaces` > 0). Some distributions restrict them further: Ubuntu 23.10 and later can
do it through AppArmor (`kernel.apparmor_restrict_unprivileged_userns`), which then needs an AppArmor
rule for the worker (see Chromium's
[AppArmor user namespace notes](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md)).
With the real engine, the worker's start-up preflight logs "browser sandbox preflight passed", or the
failure with Chromium's own message. On Kubernetes, install the same file as a `Localhost` seccomp profile for the
worker pods.
