import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(process.cwd(), "migrations/0678_dropship_vendor_standing.sql"), "utf8");
const schema = readFileSync(resolve(process.cwd(), "shared/schema/dropship.schema.ts"), "utf8");

describe("0678_dropship_vendor_standing migration", () => {
  it("records why and when a vendor is paused, and what inventory planning currently holds", () => {
    expect(migration).toContain("ADD COLUMN standing_reason VARCHAR(60)");
    expect(migration).toContain("ADD COLUMN paused_at TIMESTAMPTZ");
    expect(migration).toContain("ADD COLUMN standing_revision INTEGER NOT NULL DEFAULT 0");
    expect(migration).toContain("ADD COLUMN listing_hold_state VARCHAR(20) NOT NULL DEFAULT 'released'");
    expect(migration).toContain("ADD COLUMN listing_hold_reconciled_at TIMESTAMPTZ");
    expect(migration).toContain("ADD COLUMN listing_hold_detail TEXT");
  });

  it("ties the reason and time to the paused status and pins both enums", () => {
    expect(migration).toContain("(status <> 'paused' AND standing_reason IS NULL AND paused_at IS NULL)");
    expect(migration).toContain("(status = 'paused' AND standing_reason IS NOT NULL AND paused_at IS NOT NULL)");
    expect(migration).toContain("standing_reason IN ('card_declined', 'funding_returned', 'operator')");
    expect(migration).toContain("listing_hold_state IN ('released', 'held')");
    expect(migration).toContain("CHECK (standing_revision >= 0)");
  });

  it("turns any hand-set pause into an operator pause before the check lands, and indexes the reconcile scan", () => {
    const backfill = migration.indexOf("SET standing_reason = 'operator'");
    const check = migration.indexOf("dropship_vendors_standing_chk");
    expect(backfill).toBeGreaterThan(0);
    expect(backfill).toBeLessThan(check);
    expect(migration).toContain("WHERE status = 'paused'\n  AND standing_reason IS NULL");
    expect(migration).toContain("dropship_vendors_listing_hold_mismatch_idx");
    expect(migration).not.toMatch(/DELETE\s+FROM/i);
  });

  it("keeps the Drizzle schema aligned", () => {
    expect(schema).toContain('standingReason: varchar("standing_reason", { length: 60 })');
    expect(schema).toContain('pausedAt: timestamp("paused_at", { withTimezone: true })');
    expect(schema).toContain('standingRevision: integer("standing_revision").notNull().default(0)');
    expect(schema).toContain('listingHoldState: varchar("listing_hold_state", { length: 20 })');
    expect(schema).toContain('"dropship_vendors_standing_chk"');
    expect(schema).toContain('"dropship_vendors_listing_hold_state_chk"');
    expect(schema).toContain('export const dropshipVendorStandingReasonEnum = [');
    expect(schema).toContain('export const dropshipListingHoldStateEnum = ["released", "held"] as const;');
  });
});
