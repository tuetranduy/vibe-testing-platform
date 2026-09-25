# @platform/storage

Artifact storage (screenshots, traces, videos, generated tests, Playwright reports).

- `createS3Storage(...)` — production (S3 / MinIO). Streams of unknown length go through
  `@aws-sdk/lib-storage` `Upload` (multipart, 5 MiB parts); sha256 and byte count are computed
  while streaming.
- `createLocalStorage({ rootDir, publicBaseUrl?, signingKey? })` — **dev only**. `getSignedReadUrl`
  returns a `file://` URL (no expiry), or, when `publicBaseUrl` + `signingKey` (≥ 32 bytes) are set,
  `<publicBaseUrl>/<objectKey>?expires=<unix seconds>&signature=<hex HMAC-SHA256(signingKey, "<objectKey>\n<expires>")>`;
  the serving route must check it with `verifyLocalSignedUrl`.
- `createArtifactStorage(env)` — picks one by `ARTIFACT_STORAGE_TYPE` (`local` | `s3`) using the
  env names from `packages/config/src/env.ts`.

Object keys: `tenants/<tenantId>/runs/<runId>/<typeDir>/<sanitizedBase>-<16 hex>.<ext>`.
Signed URL TTL is clamped to `MAX_SIGNED_URL_TTL_SECONDS` (300). Infrastructure failures throw
`StorageError` (→ error category `STORAGE`); malformed ids/keys throw `InvalidArtifactKeyError`.

## How to run S3 tests locally

`src/s3-storage.test.ts` is skipped unless `S3_TEST_ENDPOINT` is set. The test creates the bucket
if it does not exist.

Against compose MinIO (`infra/compose/docker-compose.yml`):

```bash
S3_TEST_ENDPOINT=http://localhost:9000 \
S3_TEST_ACCESS_KEY_ID=minioadmin S3_TEST_SECRET_ACCESS_KEY=minioadmin \
S3_TEST_BUCKET=artifacts \
pnpm --filter @platform/storage test
```

Without Docker, `rclone serve s3` works (it verifies SigV4 signatures and enforces presigned-URL
expiry). This is how the suite was verified (rclone v1.75.1; the binary ships in the
`rclone-bin` PyPI wheel if GitHub releases are unreachable):

```bash
mkdir -p /tmp/rclone/data
rclone serve s3 --auth-key testkey,testsecret1234 --addr 127.0.0.1:9100 /tmp/rclone/data &

S3_TEST_ENDPOINT=http://127.0.0.1:9100 \
S3_TEST_ACCESS_KEY_ID=testkey S3_TEST_SECRET_ACCESS_KEY=testsecret1234 \
S3_TEST_BUCKET=artifacts \
pnpm --filter @platform/storage test
```

Note: for an expired presigned URL, AWS S3 and MinIO answer `403 AccessDenied`; rclone answers
`AccessDenied` with HTTP 400. The expiry test accepts either status but requires the
`AccessDenied` code, and checks that a still-valid URL for the same object returns 200.
