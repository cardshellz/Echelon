import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  dropshipEbayFulfillmentPolicyChecks,
  dropshipListingMarketplaceSales,
  dropshipListingPreviousMarketplaceIds,
  dropshipMarketplaceSyncNotices,
  dropshipOrderIntake,
  dropshipStoreConnections,
  dropshipUnmatchedMarketplaceOrders,
  dropshipVendorListings,
} from "../../../../../shared/schema/dropship.schema";
import { MARKETPLACE_ISSUE_CODES } from "../../domain/marketplace-sync-decision";
import {
  EBAY_SYNC_BACK_MIGRATION_FILE,
  EBAY_SYNC_BACK_MIGRATION_SUFFIX,
  ebaySyncBackMigrationSql,
} from "../fixtures/ebay-sync-back.fixture";

/**
 * The eBay sync-back migration's text (plan v4 §8). The PostgreSQL suite
 * (dropship-ebay-sync-back-migration.integration.test.ts) applies it through
 * the release executor; this pins what a release must never carry: an index
 * built CONCURRENTLY, a CHECK that scans an existing table under its lock, a
 * write to live data, or a drop other than the one trigger it recreates.
 */
describe("dropship_ebay_sync_back migration", () => {
  const sql = ebaySyncBackMigrationSql();
  const statements = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
  const alterOf = (table: string) => {
    const start = statements.indexOf(`ALTER TABLE dropship.${table}\n`);
    expect(start, table).toBeGreaterThanOrEqual(0);
    return statements.slice(start, statements.indexOf(";", start));
  };

  it("is one allocated file found by its name, with its sidecar", () => {
    expect(EBAY_SYNC_BACK_MIGRATION_FILE.endsWith(EBAY_SYNC_BACK_MIGRATION_SUFFIX)).toBe(true);
    expect(EBAY_SYNC_BACK_MIGRATION_FILE).toMatch(/^9\d{20}_dropship_ebay_sync_back\.sql$/);
    const sidecar = JSON.parse(readFileSync(resolve(process.cwd(), "migrations/metadata", `${EBAY_SYNC_BACK_MIGRATION_FILE}.json`), "utf8"));
    expect(sidecar).toMatchObject({ version: 1, migration: EBAY_SYNC_BACK_MIGRATION_FILE, ordinal: 1 });
  });

  it("takes the three altered tables' strongest lock first, store connections before listings, so no lock is upgraded inside the file", () => {
    expect(statements.trim().split(";")[0]!.replace(/\s+/g, " ").trim()).toBe("LOCK TABLE dropship.dropship_store_connections, "
      + "dropship.dropship_vendor_listings, dropship.dropship_order_intake IN ACCESS EXCLUSIVE MODE");
  });

  it("adds every CHECK on an existing table NOT VALID, so no existing table is scanned under its lock", () => {
    for (const table of ["dropship_vendor_listings", "dropship_order_intake"]) {
      const alter = alterOf(table);
      const checks = alter.match(/CHECK \(/g) ?? [];
      const notValid = alter.match(/\) NOT VALID/g) ?? [];
      expect(checks.length, table).toBeGreaterThan(0);
      expect(notValid.length, table).toBe(checks.length);
      expect(alter, table).not.toMatch(/ADD COLUMN [^,]*CHECK/);
    }
    expect(alterOf("dropship_store_connections")).not.toMatch(/CHECK|NOT NULL/);
  });

  it("allows exactly the listing issue codes the domain raises", () => {
    const listed = /marketplace_issue_codes <@ ARRAY\[([^\]]+)\]/.exec(statements)?.[1];
    expect(listed?.split(",").map((code) => code.trim().replace(/'/g, ""))).toEqual([...MARKETPLACE_ISSUE_CODES]);
  });

  it("stores nothing of a vendor's eBay title or description, and no content baseline (owner rules 2 and 3)", () => {
    expect(statements).not.toMatch(/marketplace_title|marketplace_description|content_baseline|content_notified|dropship_listing_content_revisions/);
    expect(statements).not.toMatch(/urgency|digest/i);
  });

  it("recreates only the selection trigger, with vendor_quantity_limit added and quantity_cap still unwatched", () => {
    expect(statements.match(/^\s*DROP\b/gim)).toHaveLength(1);
    expect(statements).toContain("DROP TRIGGER publication_selection_invalidation ON dropship.dropship_vendor_listings;");
    const create = statements.slice(statements.indexOf("CREATE TRIGGER publication_selection_invalidation"));
    const trigger = create.slice(0, create.indexOf(";"));
    expect(trigger.replace(/\s+/g, " ")).toContain("AFTER INSERT OR DELETE OR UPDATE OF vendor_id, store_connection_id, product_variant_id, "
      + "status, external_listing_id, external_offer_id, vendor_quantity_limit ON dropship.dropship_vendor_listings FOR EACH ROW");
    expect(trigger).toContain("inventory.notify_publication_selection_change('variant',");
    expect(trigger).toContain("'vendor_id,store_connection_id,product_variant_id,status,external_listing_id,external_offer_id,vendor_quantity_limit'");
    expect(trigger).not.toMatch(/quantity_cap/);
  });

  it("writes no live data and carries nothing a release could trip on", () => {
    expect(statements).not.toMatch(/CONCURRENTLY/i);
    expect(statements).not.toMatch(/\bRAISE\b/i);
    expect(statements).not.toMatch(/^\s*(UPDATE|DELETE|INSERT|TRUNCATE)\b/im);
    expect(statements).not.toMatch(/;\s*(UPDATE|DELETE|INSERT|TRUNCATE)\b/i);
    expect(statements).not.toMatch(/IF NOT EXISTS|IF EXISTS/i);
  });

  it("is declared in the Drizzle schema with the same names", () => {
    const tables = [dropshipListingMarketplaceSales, dropshipListingPreviousMarketplaceIds, dropshipUnmatchedMarketplaceOrders,
      dropshipEbayFulfillmentPolicyChecks, dropshipMarketplaceSyncNotices];
    for (const table of tables) {
      const config = getTableConfig(table);
      expect(config.schema).toBe("dropship");
      expect(statements).toContain(`CREATE TABLE dropship.${config.name} (`);
      for (const check of config.checks) expect(statements.replace(/\s+/g, " "), check.name).toContain(`CONSTRAINT ${check.name} CHECK`);
      for (const index of config.indexes) expect(statements, index.config.name).toContain(`CREATE INDEX ${index.config.name} ON dropship.${config.name}`);
      for (const column of config.columns) expect(statements, `${config.name}.${column.name}`).toMatch(new RegExp(`\\n\\s+${column.name} `));
    }
    // The named unique and owner keys, in both (inline REFERENCES are unnamed in SQL, as in 0086 and 0660).
    const named = tables.flatMap((table) => {
      const config = getTableConfig(table);
      return [...config.uniqueConstraints.map((unique) => unique.name), ...config.foreignKeys.map((key) => key.getName())];
    });
    for (const name of ["dropship_listing_sale_line_uk", "dropship_listing_prev_store_owner_fk", "dropship_listing_prev_id_uk",
      "dropship_unmatched_store_owner_fk", "dropship_unmatched_order_line_uk", "dropship_sync_notice_store_owner_fk", "dropship_sync_notice_subject_uk"]) {
      expect(named, name).toContain(name);
      expect(statements, name).toContain(`CONSTRAINT ${name} `);
    }
    const listing = getTableConfig(dropshipVendorListings);
    const added = ["marketplace_sync_attempted_at", "marketplace_issue_codes", "marketplace_ended_at", "observed_fulfillment_policy_id",
      "vendor_quantity_limit", "marketplace_quantity_baseline", "marketplace_quantity_baseline_at", "observed_marketplace_quantity",
      "observed_marketplace_quantity_at"];
    for (const name of added) {
      expect(listing.columns.map((column) => column.name)).toContain(name);
      expect(alterOf("dropship_vendor_listings")).toContain(`ADD COLUMN ${name} `);
    }
    // Exactly these, and nothing else, are added to the listings.
    expect(alterOf("dropship_vendor_listings").match(/ADD COLUMN \w+/g)?.map((entry) => entry.slice("ADD COLUMN ".length))).toEqual(added);
    for (const check of listing.checks.filter((entry) => !["dropship_listing_platform_chk", "dropship_listing_status_chk",
      "dropship_listing_price_chk", "dropship_listing_qty_chk"].includes(entry.name))) {
      expect(alterOf("dropship_vendor_listings")).toContain(`ADD CONSTRAINT ${check.name}`);
    }
    for (const index of ["dropship_listing_marketplace_sync_due_idx", "dropship_listing_marketplace_issues_idx"]) {
      expect(listing.indexes.map((entry) => entry.config.name)).toContain(index);
      expect(statements).toContain(`CREATE INDEX ${index} ON dropship.dropship_vendor_listings`);
    }
    expect(getTableConfig(dropshipStoreConnections).columns.map((column) => column.name)).toContain("marketplace_sales_ledger_since");
    const intake = getTableConfig(dropshipOrderIntake);
    expect(intake.columns.map((column) => column.name)).toEqual(expect.arrayContaining(["processing_attempt_count",
      "next_processing_attempt_at", "marketplace_cancelled_at", "marketplace_status_checked_at"]));
    expect(intake.checks.map((check) => check.name)).toContain("dropship_order_intake_attempt_count_chk");
    for (const index of ["dropship_order_intake_retry_due_idx", "dropship_order_intake_accepted_check_idx"]) {
      expect(intake.indexes.map((entry) => entry.config.name)).toContain(index);
      expect(statements).toContain(`CREATE INDEX ${index} ON dropship.dropship_order_intake`);
    }
  });
});
