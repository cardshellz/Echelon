import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  marketplaceListingRegistrations,
  marketplaceListingScopeProviderAccounts,
  marketplaceProviderAccounts,
  marketplaceProviderIdentityClaims,
  marketplaceProviderIdentityRoleEnum,
} from "../../../../../shared/schema/marketplace-listings.schema";

describe("marketplace listing registration Drizzle schema", () => {
  it("defines the distinct provider identity roles", () => {
    expect(marketplaceProviderIdentityRoleEnum).toEqual([
      "publication_key",
      "listing_id",
      "variant_id",
      "offer_id",
      "inventory_item_id",
    ]);
  });

  it.each([
    {
      table: marketplaceProviderAccounts,
      name: "provider_accounts",
      columns: [
        "owner_kind",
        "channel_id",
        "store_connection_id",
        "provider",
        "account_namespace",
        "external_account_id",
        "identity_scheme",
        "evidence_hash",
      ],
    },
    {
      table: marketplaceListingScopeProviderAccounts,
      name: "listing_scope_provider_accounts",
      columns: [
        "scope_id",
        "provider_account_id",
        "bound_by_type",
        "bound_by_id",
      ],
    },
    {
      table: marketplaceProviderIdentityClaims,
      name: "provider_identity_claims",
      columns: [
        "provider_account_id",
        "scope_id",
        "publication_id",
        "member_id",
        "identity_role",
        "identity_namespace",
        "external_id",
      ],
    },
    {
      table: marketplaceListingRegistrations,
      name: "listing_registrations",
      columns: [
        "scope_id",
        "provider_account_id",
        "publication_id",
        "idempotency_key",
        "request_hash",
        "observation_hash",
        "desired_state_hash",
        "observed_at",
        "registered_at",
      ],
    },
  ])(
    "defines marketplace.$name with required columns",
    ({ table, name, columns }) => {
      const config = getTableConfig(table);
      expect(config.name).toBe(name);
      const columnNames = config.columns.map((column) => column.name);
      for (const column of columns) expect(columnNames).toContain(column);
    },
  );

  it("declares global identity, owner, subject, and receipt uniqueness", () => {
    const account = getTableConfig(marketplaceProviderAccounts);
    const binding = getTableConfig(marketplaceListingScopeProviderAccounts);
    const claims = getTableConfig(marketplaceProviderIdentityClaims);
    const receipts = getTableConfig(marketplaceListingRegistrations);
    const names = [
      ...account.uniqueConstraints,
      ...account.indexes,
      ...binding.uniqueConstraints,
      ...claims.uniqueConstraints,
      ...claims.indexes,
      ...receipts.uniqueConstraints,
    ].map((constraint) =>
      "config" in constraint ? constraint.config.name : constraint.name,
    );

    expect(names).toEqual(
      expect.arrayContaining([
        "provider_accounts_global_identity_uq",
        "provider_accounts_channel_owner_uidx",
        "provider_accounts_dropship_owner_uidx",
        "listing_scope_provider_accounts_scope_account_uq",
        "provider_identity_claims_account_identity_uq",
        "provider_identity_claims_publication_role_uidx",
        "provider_identity_claims_member_role_uidx",
        "listing_registrations_scope_uq",
        "listing_registrations_publication_uq",
        "listing_registrations_scope_idem_uq",
      ]),
    );
  });
});
