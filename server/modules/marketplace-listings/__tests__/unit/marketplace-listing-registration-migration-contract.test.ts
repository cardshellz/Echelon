import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  resolve(
    process.cwd(),
    "migrations/0609_marketplace_listing_registration.sql",
  ),
  "utf8",
);
const compactMigration = migrationSql.replace(/\s+/g, " ").trim();

function expectSql(fragment: string): void {
  expect(compactMigration).toContain(fragment.replace(/\s+/g, " ").trim());
}

describe("marketplace listing registration migration contract", () => {
  it("adds exactly the four registration-owned marketplace tables", () => {
    expect(
      [
        ...migrationSql.matchAll(/CREATE TABLE marketplace\.([a-z_]+)\s*\(/g),
      ].map((match) => match[1]),
    ).toEqual([
      "provider_accounts",
      "listing_scope_provider_accounts",
      "provider_identity_claims",
      "listing_registrations",
    ]);
  });

  it("adds stable provider identity evidence to both owner models without accepting usernames", () => {
    expectSql(
      "ALTER TABLE ebay.ebay_oauth_tokens ADD COLUMN external_account_id VARCHAR(255)",
    );
    expectSql("ADD COLUMN external_account_identity_scheme VARCHAR(50)");
    expectSql("ADD COLUMN external_account_verified_at TIMESTAMPTZ");
    expectSql("environment IN ('sandbox', 'production')");
    expectSql(
      "ALTER TABLE dropship.dropship_store_connections ADD COLUMN provider_environment VARCHAR(30)",
    );
    expectSql("ADD COLUMN external_account_identity_scheme VARCHAR(40)");
    expectSql("ADD COLUMN external_account_verified_at TIMESTAMPTZ");
    expectSql("external_account_identity_scheme = 'provider_user_id'");
    expectSql("identity_scheme = 'provider_user_id'");
    expectSql(
      "lower(platform) <> 'ebay' OR provider_environment IN ('sandbox', 'production')",
    );
    expect(compactMigration).not.toMatch(/identity_scheme\s*=\s*'username'/i);
  });

  it("serializes global account ownership and account-qualified external identities", () => {
    expectSql(
      "CONSTRAINT provider_accounts_global_identity_uq UNIQUE (provider, account_namespace, external_account_id)",
    );
    expectSql("CONSTRAINT provider_accounts_owner_chk CHECK");
    expectSql(
      "CONSTRAINT provider_identity_claims_account_identity_uq UNIQUE (provider_account_id, identity_namespace, external_id)",
    );
    expectSql(
      "CREATE UNIQUE INDEX provider_identity_claims_publication_role_uidx",
    );
    expectSql("CREATE UNIQUE INDEX provider_identity_claims_member_role_uidx");
    expectSql(
      "identity_role IN ( 'publication_key', 'listing_id', 'variant_id', 'offer_id', 'inventory_item_id' )",
    );
  });

  it("requires exact immutable scope-account, subject, and publication identity matches", () => {
    expectSql(
      "CREATE TRIGGER provider_accounts_owner_verified_guard BEFORE INSERT ON marketplace.provider_accounts",
    );
    expectSql("token.external_account_verified_at = NEW.verified_at");
    expectSql("connection.external_account_verified_at = NEW.verified_at");
    expectSql("FOR UPDATE OF token");
    expectSql("FOR UPDATE;");
    expectSql(
      "CREATE TRIGGER listing_scope_provider_accounts_guard BEFORE INSERT ON marketplace.listing_scope_provider_accounts",
    );
    expectSql(
      "CREATE TRIGGER provider_identity_claims_guard BEFORE INSERT ON marketplace.provider_identity_claims",
    );
    expectSql(
      "Provider identity claim does not match publication identity data",
    );
    expectSql(
      "CREATE TRIGGER provider_accounts_immutable BEFORE UPDATE OR DELETE",
    );
    expectSql(
      "CREATE TRIGGER listing_scope_provider_accounts_immutable BEFORE UPDATE OR DELETE",
    );
    expectSql(
      "CREATE TRIGGER provider_identity_claims_immutable BEFORE UPDATE OR DELETE",
    );
    expectSql(
      "CREATE TRIGGER listing_registrations_immutable BEFORE UPDATE OR DELETE",
    );
  });

  it("permits registration only for one complete active first generation in an empty scope", () => {
    expectSql("publication_row.status <> 'active'");
    expectSql("publication_row.generation <> 1");
    expectSql("publication_row.supersedes_publication_id IS NOT NULL");
    expectSql(
      "Registration is allowed only for an empty scope without replacement history",
    );
    expectSql(
      "Registration receipt requires a complete provider identity claim set",
    );
    expectSql("CONSTRAINT listing_registrations_scope_uq UNIQUE (scope_id)");
    expectSql(
      "CONSTRAINT listing_registrations_scope_idem_uq UNIQUE (scope_id, idempotency_key)",
    );
  });

  it("blocks owner and scope identity drift after registration", () => {
    expectSql("CREATE TRIGGER listing_scopes_registered_drift_guard");
    expectSql("CREATE TRIGGER channels_registered_provider_drift_guard");
    expectSql(
      "CREATE TRIGGER ebay_oauth_tokens_registered_identity_drift_guard",
    );
    expectSql(
      "CREATE TRIGGER dropship_store_connections_registered_identity_drift_guard",
    );
    expectSql("Registered eBay token stable account identity is immutable");
    expectSql("Registered Dropship stable account identity is immutable");
    expectSql("NEW.vendor_id, NEW.platform, NEW.provider_environment");
    expectSql("OLD.vendor_id, OLD.platform, OLD.provider_environment");
  });
});
