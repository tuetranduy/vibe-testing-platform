// Derives the worker's seccomp profile (worker.json) from Docker's default one
// (https://github.com/moby/profiles/blob/main/seccomp/default.json):
//
//   node infra/seccomp/derive-worker-profile.mjs <docker default.json> infra/seccomp/worker.json
//
// The only change: clone(2) and unshare(2) may create user, PID and network namespaces without
// CAP_SYS_ADMIN, which is what Chromium's sandbox needs (it runs each renderer in them, and checks
// that it can with a clone(CLONE_NEWUSER) whose child calls unshare(CLONE_NEWUSER)). Every other rule
// is Docker's, and mount, UTS, IPC and cgroup namespaces stay denied. See README.md.
import { readFileSync, writeFileSync } from "node:fs";

const [source, target] = process.argv.slice(2);
if (!source || !target) {
  console.error("usage: derive-worker-profile.mjs <docker default.json> <worker.json>");
  process.exit(2);
}

const CLONE_NEWUSER = 0x10000000;
const CLONE_NEWPID = 0x20000000;
const CLONE_NEWNET = 0x40000000;
// Docker's mask: NEWNS | NEWCGROUP | NEWUTS | NEWIPC | NEWUSER | NEWPID | NEWNET must all be clear.
const DOCKER_MASK = 0x7e020000;
const WORKER_MASK = DOCKER_MASK & ~(CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET);

const profile = JSON.parse(readFileSync(source, "utf8"));
const cloneRules = profile.syscalls.filter(
  (r) => r.names.length === 1 && r.names[0] === "clone" && r.args?.length === 1 && r.args[0].value === DOCKER_MASK,
);
// One rule for most architectures, one for s390's argument order.
if (cloneRules.length !== 2) throw new Error(`expected Docker's 2 clone rules, found ${cloneRules.length}: has the default profile changed?`);
for (const rule of cloneRules) rule.args[0].value = WORKER_MASK;

// Docker allows unshare(2) only with CAP_SYS_ADMIN; allow it for the same namespaces as clone. Its
// flags are the first argument on every architecture.
const at = profile.syscalls.indexOf(cloneRules.at(-1)) + 1;
profile.syscalls.splice(at, 0, {
  names: ["unshare"],
  action: "SCMP_ACT_ALLOW",
  args: [{ index: 0, value: WORKER_MASK, op: "SCMP_CMP_MASKED_EQ" }],
  comment: "user, PID and network namespaces only (Chromium's sandbox)",
  excludes: { caps: ["CAP_SYS_ADMIN"] },
});

writeFileSync(target, `${JSON.stringify(profile, null, "\t")}\n`);
console.log(`${target}: clone and unshare may create user, PID and network namespaces (mask ${DOCKER_MASK} -> ${WORKER_MASK})`);
