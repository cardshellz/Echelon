import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  dropshipAuthIdentities,
  dropshipPasskeyCredentials,
  dropshipSensitiveActionChallenges,
  dropshipSensitiveActionEnum,
  dropshipStepUpMethodEnum,
} from "../schema/dropship.schema";

const migrationSql = readFileSync(
  resolve(process.cwd(), "migrations/0087_dropship_auth_identity.sql"),
  "utf8",
);

describe("Dropship V2 auth schema contract", () => {
  it("stores Card Shellz member identity separately from vendor operations", () => {
    expect((dropshipAuthIdentities as any).memberId.name).toBe("member_id");
    expect((dropshipAuthIdentities as any).primaryEmail.name).toBe("primary_email");
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS dropship.dropship_auth_identities");
    expect(migrationSql).toContain("REFERENCES membership.members(id)");
    expect(migrationSql).toContain("dropship_auth_identity_member_idx");
  });

  it("supports passkeys without storing passkey private material", () => {
    expect((dropshipPasskeyCredentials as any).credentialId.name).toBe("credential_id");
    expect((dropshipPasskeyCredentials as any).publicKey.name).toBe("public_key");
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS dropship.dropship_passkey_credentials");
    expect(migrationSql).not.toMatch(/private_key/i);
  });

  it("supports email MFA only as a sensitive-action challenge method", () => {
    expect(dropshipStepUpMethodEnum).toEqual(["passkey", "email_mfa"]);
    expect(dropshipSensitiveActionEnum).toContain("connect_store");
    expect(dropshipSensitiveActionEnum).toContain("add_funding_method");
    expect((dropshipSensitiveActionChallenges as any).challengeHash.name).toBe("challenge_hash");
    expect(migrationSql).toContain("dropship_sensitive_challenge_method_chk");
    expect(migrationSql).toContain("dropship_sensitive_challenge_idem_idx");
  });
});
