import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { installStockSelectionFixture } from "../../../inventory-planning/__tests__/fixtures/stock-selection.fixture";
import { ebaySyncBackListingColumnsSql } from "./ebay-sync-back.fixture";
import { listingPushRunsBaseFixtureSql } from "./listing-push-runs.fixture";
import { selectionOracleColumnsSql } from "./selection-oracle.fixture";

/**
 * The picks migration of PR B (step 1 plan S2-5, PLAN-B v4.1 §6), found by its name, never by its number:
 * the number is allocated under the stand-in PR 99999 and changes when the file is adopted under the real
 * one (docs/migration-allocation.md). Exactly one file may carry the name.
 */
export const SELECTED_VARIANTS_MIGRATION_SUFFIX = "_dropship_vendor_selected_variants.sql";

export const SELECTED_VARIANTS_MIGRATION_FILE: string = (() => {
  const matches = readdirSync(resolve(process.cwd(), "migrations"))
    .filter((file) => file.endsWith(SELECTED_VARIANTS_MIGRATION_SUFFIX));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one migration ending in ${SELECTED_VARIANTS_MIGRATION_SUFFIX}; found ${matches.length}.`);
  }
  return matches[0]!;
})();

export function selectedVariantsMigrationSql(): string {
  return readFileSync(resolve(process.cwd(), "migrations", SELECTED_VARIANTS_MIGRATION_FILE), "utf8");
}

/**
 * The schema the B file runs on in PostgreSQL suites (§15.3, TESTS-4), before 0743: the shared
 * listing-push-runs base (the production shapes of 0086/0091 for vendors, revisions, rules and audit
 * events), the sync-back listing columns cut from the real migration, the columns the stock selection reader
 * reads, and what the real 0743 needs that those leave out: the inventory schema with the mapping heads, the
 * eBay mapping toggle 0743 watches, and the production indexes the conversion's reads use (0086, 0091, the
 * product line key of 0002/0071), so a timing measured here reads the rules as production does.
 */
export const picksMigrationSchemaSql = `${listingPushRunsBaseFixtureSql({ picks: false })}
${ebaySyncBackListingColumnsSql({ previousIds: false })}
${selectionOracleColumnsSql}
  CREATE SCHEMA inventory;
  CREATE TABLE inventory.publication_variant_mapping_heads (publication_target_id integer NOT NULL,
    product_variant_id integer NOT NULL, active_mapping_id bigint);
  ALTER TABLE ebay.ebay_category_mappings ADD COLUMN IF NOT EXISTS listing_enabled boolean NOT NULL DEFAULT true;
  CREATE INDEX dropship_selection_rules_vendor_idx ON dropship.dropship_vendor_selection_rules(vendor_id, is_active);
  CREATE INDEX dropship_selection_rules_revision_idx ON dropship.dropship_vendor_selection_rules(revision_id);
  CREATE INDEX dropship_selection_rule_rev_vendor_created_idx
    ON dropship.dropship_vendor_selection_rule_set_revisions(vendor_id, created_at);
  CREATE UNIQUE INDEX plp_line_product_idx ON catalog.product_line_products(product_line_id, product_id);
`;

/**
 * Installs the reduced owner tables the real 0743 checks for (the shared stock selection fixture, additive),
 * then the real 0743: the publication selection gate and invalidation on every table it names, so the B file
 * meets production's triggers. Never creates the picks table (the B file's CREATE TABLE has no IF NOT EXISTS).
 */
export async function installPicksMigrationPrerequisites(pool: Pick<Pool, "query">): Promise<void> {
  await installStockSelectionFixture(pool);
  await pool.query(readFileSync(resolve(process.cwd(), "migrations/0743_publication_selection_work.sql"), "utf8"));
}

/** The publication selection gate's row in `pg_locks` (0743 takes it with `pg_try_advisory_xact_lock(918419, 0)`). */
export const PUBLICATION_SELECTION_GATE_LOCK_SQL = "classid = 918419 AND objid = 0 AND objsubid = 2";

/**
 * Production indexes a timed picks write and 0743's invalidation use (the 0633 heads key, 0002's variants by
 * product), so a gate hold measured on this schema reads the heads as production does (B1e scale notes).
 */
export const PICKS_PRODUCTION_INDEXES_SQL = `
  ALTER TABLE inventory.publication_variant_mapping_heads ADD PRIMARY KEY (publication_target_id, product_variant_id);
  CREATE INDEX IF NOT EXISTS idx_product_variants_product_id ON catalog.product_variants(product_id);
`;

/** How often the gate sampler looks at `pg_locks`. */
const GATE_SAMPLE_INTERVAL_MS = 2;

export interface PublicationSelectionGateSample { at: number; held: boolean }

/** Samples whether any backend holds the gate's exclusive side, about every 2 ms on a connection of its own, until stopped. */
export function samplePublicationSelectionGate(pool: Pool): { stop: () => Promise<PublicationSelectionGateSample[]> } {
  const samples: PublicationSelectionGateSample[] = [];
  let running = true;
  const loop = (async () => {
    const client = await pool.connect();
    try {
      while (running) {
        const held = (await client.query<{ held: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory'
          AND ${PUBLICATION_SELECTION_GATE_LOCK_SQL} AND mode = 'ExclusiveLock' AND granted) AS held`)).rows[0]!.held;
        samples.push({ at: performance.now(), held });
        await new Promise<void>((resolve) => { setTimeout(resolve, GATE_SAMPLE_INTERVAL_MS); });
      }
    } finally {
      client.release();
    }
  })();
  return { stop: async () => { running = false; await loop; return samples; } };
}

/** The span between the first and the last sample that saw the gate held; 0 when none did. */
export function publicationSelectionGateHoldMs(samples: readonly PublicationSelectionGateSample[]): number {
  const held = samples.filter((sample) => sample.held);
  return held.length === 0 ? 0 : held[held.length - 1]!.at - held[0]!.at;
}
