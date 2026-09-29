import { and, eq, inArray, isNull } from "drizzle-orm";
import { TERMINAL_LIFECYCLES } from "./state-machine";
import type { Executor } from "./client";
import { newId } from "./ids";
import { runSecrets, testRuns } from "./schema";

export interface EncryptedSecretRow {
  name: string;
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  /** HMAC of the value (secretFingerprint); optional for callers that predate it. */
  fingerprint?: Buffer;
}

export interface SecretFingerprintRow {
  digest: Buffer;
  /** The value's UTF-8 length (= the AES-GCM ciphertext's). */
  bytes: number;
}

export class SecretRepository {
  constructor(private readonly db: Executor) {}

  async insertMany(runId: string, secrets: EncryptedSecretRow[]): Promise<void> {
    if (secrets.length === 0) return;
    await this.db.insert(runSecrets).values(secrets.map((s) => ({ id: newId("sec"), runId, ...s })));
  }

  /** Encrypted secrets not yet purged. Decryption happens only in the worker. */
  async listActive(runId: string): Promise<EncryptedSecretRow[]> {
    const rows = await this.db
      .select()
      .from(runSecrets)
      .where(and(eq(runSecrets.runId, runId), isNull(runSecrets.purgedAt)));
    return rows.map(({ name, ciphertext, iv, authTag }) => ({ name, ciphertext, iv, authTag }));
  }

  /** Fingerprints of the run's unpurged secrets (none for runs created before fingerprints existed). */
  async listFingerprints(runId: string): Promise<SecretFingerprintRow[]> {
    const rows = await this.db
      .select({ fingerprint: runSecrets.fingerprint, ciphertext: runSecrets.ciphertext })
      .from(runSecrets)
      .where(and(eq(runSecrets.runId, runId), isNull(runSecrets.purgedAt)));
    return rows
      .filter((r): r is { fingerprint: Buffer; ciphertext: Buffer } => r.fingerprint !== null && r.fingerprint.length > 0)
      .map((r) => ({ digest: r.fingerprint, bytes: r.ciphertext.length }));
  }

  async listNames(runId: string): Promise<string[]> {
    const rows = await this.db.select({ name: runSecrets.name }).from(runSecrets).where(eq(runSecrets.runId, runId));
    return rows.map((r) => r.name);
  }

  /** Wipes ciphertext and marks purged. Idempotent. Returns number of rows purged now. */
  async purge(runId: string): Promise<number> {
    const empty = Buffer.alloc(0);
    const rows = await this.db
      .update(runSecrets)
      .set({ purgedAt: new Date(), ciphertext: empty, iv: empty, authTag: empty, fingerprint: null })
      .where(and(eq(runSecrets.runId, runId), isNull(runSecrets.purgedAt)))
      .returning({ id: runSecrets.id });
    return rows.length;
  }

  /** Runs that ended but still hold unpurged secrets (safety net for the reaper). */
  async findTerminalRunIdsWithActiveSecrets(limit = 100): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ runId: runSecrets.runId })
      .from(runSecrets)
      .innerJoin(testRuns, eq(testRuns.id, runSecrets.runId))
      .where(and(isNull(runSecrets.purgedAt), inArray(testRuns.lifecycle, [...TERMINAL_LIFECYCLES])))
      .limit(limit);
    return rows.map((r) => r.runId);
  }
}
