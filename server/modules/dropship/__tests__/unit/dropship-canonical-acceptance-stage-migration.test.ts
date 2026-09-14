import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  resolve(__dirname, "../../../../../migrations/0667_dropship_canonical_acceptance_stages.sql"),
  "utf8",
);

describe("dropship canonical acceptance stage migration", () => {
  it("persists one durable stage per intake and OMS order with restricted lifecycle ownership", () => {
    expect(MIGRATION).toMatch(/intake_id integer PRIMARY KEY[\s\S]*ON DELETE RESTRICT/);
    expect(MIGRATION).toMatch(/oms_order_id bigint NOT NULL UNIQUE[\s\S]*ON DELETE RESTRICT/);
    expect(MIGRATION).toMatch(/wms_order_id integer REFERENCES wms\.orders\(id\) ON DELETE RESTRICT/);
    expect(MIGRATION).toContain("CREATE TABLE IF NOT EXISTS dropship.dropship_order_acceptance_claim_attempts");
    expect(MIGRATION).toContain("PRIMARY KEY (intake_id, attempt_number)");
    expect(MIGRATION).toContain("dropship_order_acceptance_stage_current_attempt_fk");
    expect(MIGRATION).toContain("availability_claim_id bigint UNIQUE");
    expect(MIGRATION).toContain("claim_outcome IN ('claimed', 'no_claim_required')");
  });

  it("requires exact mutually exclusive row shapes including durable compensation states", () => {
    expect(MIGRATION).toMatch(
      /state = 'prepared'[\s\S]*wms_order_id IS NULL[\s\S]*inventory_claimed_at IS NULL[\s\S]*finalized_at IS NULL/,
    );
    expect(MIGRATION).toMatch(
      /state = 'inventory_claimed'[\s\S]*wms_order_id IS NOT NULL[\s\S]*inventory_claimed_at IS NOT NULL[\s\S]*finalized_at IS NULL/,
    );
    expect(MIGRATION).toMatch(
      /state = 'compensation_pending'[\s\S]*inventory_release_requested_at IS NOT NULL[\s\S]*inventory_released_at IS NULL[\s\S]*inventory_release_reason IS NOT NULL/,
    );
    expect(MIGRATION).toMatch(
      /state = 'inventory_released'[\s\S]*inventory_release_requested_at IS NOT NULL[\s\S]*inventory_released_at IS NOT NULL[\s\S]*expired_at IS NULL/,
    );
    expect(MIGRATION).toMatch(
      /state = 'expired'[\s\S]*inventory_released_at IS NOT NULL[\s\S]*expired_at IS NOT NULL[\s\S]*finalized_at IS NULL/,
    );
    expect(MIGRATION).toMatch(
      /state = 'finalized'[\s\S]*wms_order_id IS NOT NULL[\s\S]*inventory_claimed_at IS NOT NULL[\s\S]*finalized_at IS NOT NULL/,
    );
  });

  it("constrains frozen identity, money, pricing, and timestamp evidence", () => {
    expect(MIGRATION).toContain("btrim(submitted_idempotency_key) <> ''");
    expect(MIGRATION).toContain("btrim(member_id) <> ''");
    expect(MIGRATION).toContain("currency ~ '^[A-Z]{3}$'");
    expect(MIGRATION).toContain("jsonb_typeof(pricing_snapshot) = 'object'");
    expect(MIGRATION).toContain(
      "total_debit_cents = wholesale_subtotal_cents + shipping_cents + fees_cents",
    );
    expect(MIGRATION).toContain("updated_at >= prepared_at");
    expect(MIGRATION).toContain("updated_at >= inventory_claimed_at");
    expect(MIGRATION).toContain("updated_at >= inventory_release_requested_at");
    expect(MIGRATION).toContain("updated_at >= inventory_released_at");
    expect(MIGRATION).toContain("updated_at >= expired_at");
    expect(MIGRATION).toContain("updated_at >= finalized_at");
    expect(MIGRATION).toContain("dropship acceptance stage frozen evidence is immutable");
    expect(MIGRATION).toContain("invalid dropship acceptance stage transition");
    expect(MIGRATION).toContain("dropship acceptance WMS identity is immutable");
    expect(MIGRATION).toContain("dropship acceptance claim attempts are append-only");
    expect(MIGRATION).toContain("dropship acceptance claim attempt identity is immutable");
    expect(MIGRATION).toContain("dropship acceptance attempt does not match an active canonical inventory claim");
    expect(MIGRATION).toContain("dropship acceptance no-claim attempt conflicts with active inventory ownership");
    expect(MIGRATION).toContain("dropship acceptance stage cannot reopen without a durable released claim attempt");
    expect(MIGRATION).toContain("dropship acceptance stage does not match its current claim attempt");
  });
});
