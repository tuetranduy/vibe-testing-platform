import { and, asc, eq, inArray } from "drizzle-orm";
import type { Executor } from "./client";
import { newId } from "./ids";
import { credentialProfileSecrets, credentialProfiles } from "./schema";
import { NameTakenError } from "./test-data-set-repository";
import { isUniqueViolation } from "./user-repository";

/** A value as stored: the output of @platform/security's encryptProfileSecret (db does not depend on security). */
export interface EncryptedValue {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

export interface CredentialProfileRow {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  /** Sorted. */
  secretNames: string[];
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Saved credential profiles (V1.1 F4), tenant-scoped. Values arrive encrypted and leave encrypted: only the
 * API's run creation decrypts them (getEncrypted), to copy them into the run's own secrets.
 */
export class CredentialProfileRepository {
  constructor(private readonly db: Executor) {}

  private async namesFor(ids: string[]): Promise<Map<string, string[]>> {
    const out = new Map(ids.map((id) => [id, [] as string[]]));
    if (ids.length === 0) return out;
    const rows = await this.db
      .select({ profileId: credentialProfileSecrets.profileId, name: credentialProfileSecrets.name })
      .from(credentialProfileSecrets)
      .where(inArray(credentialProfileSecrets.profileId, ids))
      .orderBy(asc(credentialProfileSecrets.name));
    for (const r of rows) out.get(r.profileId)?.push(r.name);
    return out;
  }

  async list(tenantId: string): Promise<CredentialProfileRow[]> {
    const rows = await this.db
      .select()
      .from(credentialProfiles)
      .where(eq(credentialProfiles.tenantId, tenantId))
      .orderBy(asc(credentialProfiles.name));
    const names = await this.namesFor(rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, secretNames: names.get(r.id) ?? [] }));
  }

  async find(tenantId: string, id: string): Promise<CredentialProfileRow | null> {
    const [row] = await this.db
      .select()
      .from(credentialProfiles)
      .where(and(eq(credentialProfiles.tenantId, tenantId), eq(credentialProfiles.id, id)));
    if (!row) return null;
    return { ...row, secretNames: (await this.namesFor([row.id])).get(row.id) ?? [] };
  }

  /**
   * Creates the profile, then its values: `encrypt` is called with the new id (the AAD binds each value to
   * it). One transaction, so a failure leaves nothing behind.
   */
  async create(
    input: { tenantId: string; name: string; description: string; createdBy: string | null },
    secrets: { name: string; encrypt: (profileId: string) => EncryptedValue }[],
  ): Promise<CredentialProfileRow> {
    const id = newId("cp");
    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(credentialProfiles).values({ id, ...input });
        if (secrets.length > 0) {
          await tx.insert(credentialProfileSecrets).values(secrets.map((s) => ({ profileId: id, name: s.name, ...s.encrypt(id) })));
        }
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new NameTakenError("credential profile");
      throw err;
    }
    return (await this.find(input.tenantId, id))!;
  }

  /** Renames / re-describes, replaces the given values and deletes those set to null. Null when not found. */
  async update(
    tenantId: string,
    id: string,
    patch: { name?: string; description?: string },
    secrets: { set: { name: string; value: EncryptedValue }[]; remove: string[] },
  ): Promise<CredentialProfileRow | null> {
    try {
      const found = await this.db.transaction(async (tx) => {
        const [row] = await tx
          .update(credentialProfiles)
          .set({ ...patch, updatedAt: new Date() })
          .where(and(eq(credentialProfiles.tenantId, tenantId), eq(credentialProfiles.id, id)))
          .returning({ id: credentialProfiles.id });
        if (!row) return false;
        if (secrets.remove.length > 0) {
          await tx
            .delete(credentialProfileSecrets)
            .where(and(eq(credentialProfileSecrets.profileId, id), inArray(credentialProfileSecrets.name, secrets.remove)));
        }
        for (const s of secrets.set) {
          const values = { ...s.value, updatedAt: new Date() };
          await tx
            .insert(credentialProfileSecrets)
            .values({ profileId: id, name: s.name, ...values })
            .onConflictDoUpdate({ target: [credentialProfileSecrets.profileId, credentialProfileSecrets.name], set: values });
        }
        return true;
      });
      return found ? this.find(tenantId, id) : null;
    } catch (err) {
      if (isUniqueViolation(err)) throw new NameTakenError("credential profile");
      throw err;
    }
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(credentialProfiles)
      .where(and(eq(credentialProfiles.tenantId, tenantId), eq(credentialProfiles.id, id)))
      .returning({ id: credentialProfiles.id });
    return rows.length > 0;
  }

  /** API only, at run creation: the profile's encrypted values by name (tenant-scoped). Null when not found. */
  async getEncrypted(
    tenantId: string,
    id: string,
  ): Promise<{ profile: CredentialProfileRow; secrets: (EncryptedValue & { name: string })[] } | null> {
    const profile = await this.find(tenantId, id);
    if (!profile) return null;
    const secrets = await this.db
      .select({
        name: credentialProfileSecrets.name,
        ciphertext: credentialProfileSecrets.ciphertext,
        iv: credentialProfileSecrets.iv,
        authTag: credentialProfileSecrets.authTag,
      })
      .from(credentialProfileSecrets)
      .where(eq(credentialProfileSecrets.profileId, id))
      .orderBy(asc(credentialProfileSecrets.name));
    return { profile, secrets };
  }
}
