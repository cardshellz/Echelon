import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { productVariants } from "../../../../../shared/schema/catalog.schema";
import {
  marketplaceChannelListingScopes,
  marketplaceDropshipListingScopes,
  marketplaceListingPublicationMembers,
  marketplaceListingPublications,
  marketplaceListingReplacementEvents,
  marketplaceListingReplacementOperations,
  marketplaceListingReplacementSteps,
  marketplaceListingScopes,
} from "../../../../../shared/schema/marketplace-listings.schema";

const migrationSql = readFileSync(
  resolve(
    process.cwd(),
    "migrations/0607_marketplace_listing_replacement_foundation.sql",
  ),
  "utf8",
);
const compactMigration = migrationSql.replace(/\s+/g, " ").trim();
const marketplaceTables: readonly PgTable[] = [
  marketplaceListingScopes,
  marketplaceChannelListingScopes,
  marketplaceDropshipListingScopes,
  marketplaceListingPublications,
  marketplaceListingPublicationMembers,
  marketplaceListingReplacementOperations,
  marketplaceListingReplacementSteps,
  marketplaceListingReplacementEvents,
];

function expectSql(fragment: string): void {
  expect(compactMigration).toContain(fragment.replace(/\s+/g, " ").trim());
}

function sqlOccurrenceCount(fragment: string): number {
  return (
    compactMigration.split(fragment.replace(/\s+/g, " ").trim()).length - 1
  );
}

function configuredIndexNames(table: PgTable): string[] {
  return getTableConfig(table)
    .indexes.map((index) => index.config.name)
    .filter((name): name is string => name !== undefined)
    .sort();
}

function configuredForeignKeyNames(table: PgTable): string[] {
  return getTableConfig(table)
    .foreignKeys.map((foreignKey) => foreignKey.getName())
    .sort();
}

function configuredUniqueConstraintNames(table: PgTable): string[] {
  return getTableConfig(table)
    .uniqueConstraints.map((constraint) => constraint.name)
    .sort();
}

function configuredUniqueIndexNames(table: PgTable): string[] {
  return getTableConfig(table)
    .indexes.filter((index) => index.config.unique)
    .map((index) => index.config.name)
    .filter((name): name is string => name !== undefined)
    .sort();
}

function migrationMarketplaceObjectNames(pattern: RegExp): string[] {
  return [...migrationSql.matchAll(pattern)]
    .map((match) => match[1])
    .filter((name) =>
      /^(?:listing_|channel_listing_|dropship_listing_)/.test(name),
    )
    .sort();
}

function configuredNamesForAllTables(
  getNames: (table: PgTable) => string[],
): string[] {
  return marketplaceTables.flatMap(getNames).sort();
}

function configuredCheckNames(table: PgTable): string[] {
  return getTableConfig(table)
    .checks.map((constraint) => constraint.name)
    .sort();
}

describe("marketplace listing replacement integrity contract", () => {
  it("keeps the Drizzle concurrency and history indexes explicit", () => {
    expect(configuredIndexNames(marketplaceListingPublications)).toEqual(
      expect.arrayContaining([
        "listing_publications_active_scope_uidx",
        "listing_publications_external_listing_uidx",
        "listing_publications_provider_key_uidx",
        "listing_publications_scope_history_idx",
      ]),
    );
    expect(
      configuredIndexNames(marketplaceListingReplacementOperations),
    ).toEqual(
      expect.arrayContaining([
        "listing_replacement_operations_active_scope_uidx",
        "listing_replacement_operations_history_idx",
        "listing_replacement_operations_lease_idx",
      ]),
    );
    expect(configuredIndexNames(marketplaceListingReplacementSteps)).toEqual(
      expect.arrayContaining([
        "listing_replacement_steps_running_operation_uidx",
      ]),
    );
    expect(configuredIndexNames(marketplaceListingReplacementEvents)).toEqual(
      expect.arrayContaining([
        "listing_replacement_events_operation_time_idx",
        "listing_replacement_events_operation_version_uidx",
        "listing_replacement_events_step_version_uidx",
      ]),
    );
  });

  it("keeps the catalog composite identity required by publication members in Drizzle", () => {
    expect(configuredUniqueIndexNames(productVariants)).toContain(
      "product_variants_id_product_uidx",
    );
  });

  it("keeps composite cross-table identities in the Drizzle model", () => {
    expect(
      configuredForeignKeyNames(marketplaceChannelListingScopes),
    ).toContain("channel_listing_scopes_scope_product_fk");
    expect(
      configuredForeignKeyNames(marketplaceDropshipListingScopes),
    ).toContain("dropship_listing_scopes_scope_product_fk");
    expect(configuredForeignKeyNames(marketplaceListingPublications)).toEqual(
      expect.arrayContaining([
        "listing_publications_scope_product_fk",
        "listing_publications_supersedes_scope_fk",
      ]),
    );
    expect(
      configuredForeignKeyNames(marketplaceListingPublicationMembers),
    ).toEqual(
      expect.arrayContaining([
        "listing_publication_members_publication_fk",
        "listing_publication_members_variant_product_fk",
      ]),
    );
    expect(
      configuredForeignKeyNames(marketplaceListingReplacementOperations),
    ).toEqual(
      expect.arrayContaining([
        "listing_replacement_operations_source_scope_fk",
        "listing_replacement_operations_target_scope_fk",
      ]),
    );
    expect(
      configuredForeignKeyNames(marketplaceListingReplacementEvents),
    ).toContain("listing_replacement_events_step_operation_phase_fk");
  });

  it("keeps SQL unique constraints and partial unique indexes aligned with Drizzle", () => {
    const drizzleUniqueConstraints = configuredNamesForAllTables(
      configuredUniqueConstraintNames,
    );
    const sqlUniqueConstraints = migrationMarketplaceObjectNames(
      /\bCONSTRAINT\s+([a-z][a-z0-9_]*)\s+UNIQUE\s*\(/gi,
    );
    expect(drizzleUniqueConstraints).toEqual(sqlUniqueConstraints);

    const drizzleUniqueIndexes = configuredNamesForAllTables(
      configuredUniqueIndexNames,
    );
    const sqlUniqueIndexes = migrationMarketplaceObjectNames(
      /\bCREATE\s+UNIQUE\s+INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-z][a-z0-9_]*)/gi,
    );
    expect(drizzleUniqueIndexes).toEqual(sqlUniqueIndexes);

    expect(drizzleUniqueConstraints.every((name) => name.endsWith("_uq"))).toBe(
      true,
    );
    expect(drizzleUniqueIndexes.every((name) => name.endsWith("_uidx"))).toBe(
      true,
    );
  });

  it("keeps chronology and lifecycle checks represented in Drizzle", () => {
    expect(configuredCheckNames(marketplaceListingPublications)).toEqual(
      expect.arrayContaining([
        "listing_publications_lifecycle_chk",
        "listing_publications_time_chk",
      ]),
    );
    expect(
      configuredCheckNames(marketplaceListingReplacementOperations),
    ).toEqual(
      expect.arrayContaining([
        "listing_replacement_operations_lifecycle_chk",
        "listing_replacement_operations_time_chk",
      ]),
    );
    expect(configuredCheckNames(marketplaceListingReplacementSteps)).toEqual(
      expect.arrayContaining([
        "listing_replacement_steps_lifecycle_chk",
        "listing_replacement_steps_path_phase_chk",
        "listing_replacement_steps_time_chk",
      ]),
    );
  });

  it("binds event evidence to a step from the same operation and phase", () => {
    expectSql(`
      CONSTRAINT listing_replacement_steps_id_operation_phase_uq
      UNIQUE (id, operation_id, phase)
    `);
    expectSql(`
      CONSTRAINT listing_replacement_events_step_operation_phase_fk
      FOREIGN KEY (step_id, operation_id, phase)
      REFERENCES marketplace.listing_replacement_steps(id, operation_id, phase)
      ON DELETE RESTRICT
    `);
  });

  it("requires publication, operation, and step timestamps to form valid chronology", () => {
    expectSql(`
      verified_at IS NULL OR (
        published_at IS NOT NULL AND verified_at >= published_at
      )
    `);
    expectSql(`
      retired_at IS NULL OR (
        verified_at IS NOT NULL AND retired_at >= verified_at
      )
    `);
    expectSql(`
      status = 'active'
      AND external_listing_id IS NOT NULL
      AND published_at IS NOT NULL
      AND verified_at IS NOT NULL
      AND retired_at IS NULL
    `);
    expect(
      sqlOccurrenceCount(`
      completed_at IS NULL OR (
        completed_at >= created_at
        AND (started_at IS NULL OR completed_at >= started_at)
      )
    `),
    ).toBe(2);
    expectSql(`
      status = 'cancelled'
      AND current_phase = 'preflight'
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND started_at IS NULL
      AND completed_at IS NOT NULL
      AND error_code IS NULL
    `);
  });

  it("uses null-safe operation validation and freezes membership before activation", () => {
    expectSql("source_status IS DISTINCT FROM 'active'");
    expectSql("target_status IS DISTINCT FROM 'planned'");
    expectSql("target_predecessor IS DISTINCT FROM NEW.source_publication_id");
    expectSql("target_hash IS DISTINCT FROM NEW.desired_state_hash");
    expectSql("publication_status IS DISTINCT FROM 'planned'");
  });
});
