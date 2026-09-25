import { createLocalStorage } from "./local-storage";
import { createS3Storage } from "./s3-storage";
import { type ArtifactStorage, StorageError } from "./storage";

export {
  type ArtifactStorage,
  type HashingStream,
  type PutArtifactInput,
  type PutArtifactResult,
  type StorageOperation,
  createHashingStream,
  InvalidArtifactKeyError,
  MAX_SIGNED_URL_TTL_SECONDS,
  normalizeTtl,
  StorageError,
} from "./storage";
export { assertValidObjectKey, buildObjectKey, type ObjectKeyInput, sanitizeFileName, TYPE_DIRS } from "./object-key";
export {
  createLocalStorage,
  type LocalStorageOptions,
  resolveLocalObjectPath,
  verifyLocalSignedUrl,
} from "./local-storage";
export { createS3Storage, type S3StorageOptions } from "./s3-storage";

/**
 * Env-shaped config (field names from packages/config/src/env.ts). Accepts both the raw
 * process.env strings and the parsed `Env` (where S3_FORCE_PATH_STYLE is already a boolean).
 */
export interface ArtifactStorageConfig {
  ARTIFACT_STORAGE_TYPE?: "local" | "s3" | (string & {}) | undefined;
  ARTIFACT_BUCKET?: string | undefined;
  ARTIFACT_LOCAL_DIR?: string | undefined;
  S3_ENDPOINT?: string | undefined;
  S3_REGION?: string | undefined;
  S3_ACCESS_KEY_ID?: string | undefined;
  S3_SECRET_ACCESS_KEY?: string | undefined;
  S3_FORCE_PATH_STYLE?: boolean | "true" | "false" | (string & {}) | undefined;
}

export interface ArtifactStorageOverrides {
  /** Local storage only: serve via an HMAC-signed HTTP URL instead of file://. */
  localPublicBaseUrl?: string;
  localSigningKey?: Buffer;
}

const DEFAULT_LOCAL_DIR = "./.artifacts";
const DEFAULT_REGION = "us-east-1";

/** Picks the implementation from ARTIFACT_STORAGE_TYPE ("local" | "s3"). Throws StorageError on bad config. */
export function createArtifactStorage(
  config: ArtifactStorageConfig,
  overrides: ArtifactStorageOverrides = {},
): ArtifactStorage {
  const type = config.ARTIFACT_STORAGE_TYPE;
  if (type === "local") {
    return createLocalStorage({
      rootDir: config.ARTIFACT_LOCAL_DIR || DEFAULT_LOCAL_DIR,
      ...(overrides.localPublicBaseUrl ? { publicBaseUrl: overrides.localPublicBaseUrl } : {}),
      ...(overrides.localSigningKey ? { signingKey: overrides.localSigningKey } : {}),
    });
  }
  if (type === "s3") {
    const missing = (["ARTIFACT_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const).filter((k) => !config[k]);
    if (missing.length > 0) {
      throw new StorageError(`${missing.join(", ")} required when ARTIFACT_STORAGE_TYPE=s3`, { operation: "config" });
    }
    const fps = config.S3_FORCE_PATH_STYLE;
    return createS3Storage({
      bucket: config.ARTIFACT_BUCKET!,
      endpoint: config.S3_ENDPOINT || undefined,
      region: config.S3_REGION || DEFAULT_REGION,
      accessKeyId: config.S3_ACCESS_KEY_ID!,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY!,
      forcePathStyle: fps === undefined ? true : fps === true || fps === "true",
    });
  }
  throw new StorageError(`ARTIFACT_STORAGE_TYPE must be "local" or "s3", got ${JSON.stringify(type)}`, {
    operation: "config",
  });
}
