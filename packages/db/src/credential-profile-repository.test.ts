import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CredentialProfileRepository } from "./credential-profile-repository";
import { NameTakenError } from "./test-data-set-repository";
import { OTHER_TENANT_ID, TEST_TENANT_ID, createTestDatabase, type TestDatabase } from "./testing";

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => tdb?.drop());

/** Stand-in ciphertext (the API encrypts with encryptProfileSecret before saving). */
const enc = (tag: string) => ({ ciphertext: Buffer.from(`c-${tag}`), iv: Buffer.alloc(12, 1), authTag: Buffer.alloc(16, 2) });

describe("CredentialProfileRepository", () => {
  it("creates a profile with values bound to its id, lists names only, and reads values back encrypted", async () => {
    const repo = new CredentialProfileRepository(tdb.db);
    const seen: string[] = [];
    const p = await repo.create({ tenantId: TEST_TENANT_ID, name: "Staging admin", description: "QA", createdBy: null }, [
      { name: "username", encrypt: (id) => (seen.push(id), enc("u")) },
      { name: "password", encrypt: (id) => (seen.push(id), enc("p")) },
    ]);
    expect(seen).toEqual([p.id, p.id]);
    expect(p).toMatchObject({ name: "Staging admin", description: "QA", secretNames: ["password", "username"] });
    expect(JSON.stringify(await repo.list(TEST_TENANT_ID))).not.toContain("c-p");
    const got = await repo.getEncrypted(TEST_TENANT_ID, p.id);
    expect(got!.secrets.map((s) => [s.name, s.ciphertext.toString()])).toEqual([
      ["password", "c-p"],
      ["username", "c-u"],
    ]);
    expect(await repo.getEncrypted(OTHER_TENANT_ID, p.id)).toBeNull();
  });

  it("updates: renames, replaces and removes values; leaves others alone", async () => {
    const repo = new CredentialProfileRepository(tdb.db);
    const p = await repo.create({ tenantId: TEST_TENANT_ID, name: "To edit", description: "", createdBy: null }, [
      { name: "username", encrypt: () => enc("u1") },
      { name: "password", encrypt: () => enc("p1") },
    ]);
    const updated = await repo.update(
      TEST_TENANT_ID,
      p.id,
      { name: "Edited" },
      {
        set: [
          { name: "password", value: enc("p2") },
          { name: "pin", value: enc("n1") },
        ],
        remove: ["username"],
      },
    );
    expect(updated).toMatchObject({ name: "Edited", secretNames: ["password", "pin"] });
    const got = await repo.getEncrypted(TEST_TENANT_ID, p.id);
    expect(got!.secrets.map((s) => s.ciphertext.toString())).toEqual(["c-p2", "c-n1"]);
    expect(await repo.update(OTHER_TENANT_ID, p.id, { name: "x" }, { set: [], remove: [] })).toBeNull();
  });

  it("refuses a duplicate name, and deleting removes the values too", async () => {
    const repo = new CredentialProfileRepository(tdb.db);
    const p = await repo.create({ tenantId: TEST_TENANT_ID, name: "Once", description: "", createdBy: null }, [
      { name: "password", encrypt: () => enc("x") },
    ]);
    await expect(repo.create({ tenantId: TEST_TENANT_ID, name: "Once", description: "", createdBy: null }, [])).rejects.toBeInstanceOf(
      NameTakenError,
    );
    expect(await repo.remove(OTHER_TENANT_ID, p.id)).toBe(false);
    expect(await repo.remove(TEST_TENANT_ID, p.id)).toBe(true);
    const { rows } = await tdb.pool.query("SELECT count(*)::int AS n FROM credential_profile_secrets WHERE profile_id = $1", [p.id]);
    expect(rows[0].n).toBe(0);
  });
});
