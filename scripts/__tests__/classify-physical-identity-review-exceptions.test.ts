import { describe, expect, it } from "vitest";

async function loadModule() {
  process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
  return await import("../classify-physical-identity-review-exceptions");
}

describe("classify-physical-identity-review-exceptions", () => {
  it("parses CLI flags with dry-run defaults", async () => {
    const { parseFlags } = await loadModule();

    expect(parseFlags([])).toEqual({
      mode: "dry-run",
      help: false,
      limit: 100,
      operator: "script:classify-physical-identity-review-exceptions",
      includeNotFoundAfterEnrichment: false,
    });
    expect(parseFlags([
      "--execute",
      "--limit=all",
      "--operator=ops",
      "--include-not-found-after-enrichment",
    ])).toEqual({
      mode: "execute",
      help: false,
      limit: null,
      operator: "ops",
      includeNotFoundAfterEnrichment: true,
    });
  });

  it("rejects invalid CLI input", async () => {
    const { parseFlags } = await loadModule();

    expect(() => parseFlags(["--execute", "--dry-run"])).toThrow(/Cannot pass both/);
    expect(() => parseFlags(["--limit=0"])).toThrow(/positive integer or all/);
    expect(() => parseFlags(["--limit=nope"])).toThrow(/positive integer or all/);
    expect(() => parseFlags(["--operator="])).toThrow(/operator cannot be blank/);
    expect(() => parseFlags(["--operation=all"])).toThrow(/Unknown flag/);
    expect(() => parseFlags(["--helpfully"])).toThrow(/Unknown flag/);
  });

  it("keeps review reason values within the outbound shipment column limit", async () => {
    const {
      TRACKING_COLLISION_REVIEW_REASON,
      NOT_FOUND_REVIEW_REASON,
      LEGACY_AGGREGATE_COVERED_REVIEW_REASON,
    } = await loadModule();

    expect(TRACKING_COLLISION_REVIEW_REASON.length).toBeLessThanOrEqual(100);
    expect(NOT_FOUND_REVIEW_REASON.length).toBeLessThanOrEqual(100);
    expect(LEGACY_AGGREGATE_COVERED_REVIEW_REASON.length).toBeLessThanOrEqual(100);
  });

  it("selects only unclassified shipped aggregate rows that lack physical identity by default", async () => {
    const { physicalIdentityReviewCandidateSql } = await loadModule();
    const sql = physicalIdentityReviewCandidateSql(25, true);

    expect(sql).toContain("s.status::text = 'shipped'");
    expect(sql).toContain("NULLIF(BTRIM(COALESCE(s.tracking_number, '')), '') IS NOT NULL");
    expect(sql).toContain("NULLIF(BTRIM(COALESCE(s.external_fulfillment_id, '')), '') IS NULL");
    expect(sql).toContain("COALESCE(s.requires_review, false) = false");
    expect(sql).toContain("FOR UPDATE OF s");
    expect(sql).not.toContain("missing_physical_identity_candidates");
    expect(sql).not.toContain("physical_identity_not_found_after_enrichment");
    expect(sql).toContain("NULLIF(sibling.shipstation_order_id::text, '')");
    expect(sql).toContain("NULLIF(s.shipstation_order_id::text, '')");
  });

  it("requires explicit opt-in before classifying generic not-found rows", async () => {
    const {
      physicalIdentityReviewCandidateSql,
      NOT_FOUND_REVIEW_REASON,
      TRACKING_COLLISION_REVIEW_REASON,
    } = await loadModule();
    const sql = physicalIdentityReviewCandidateSql(25, false, true);

    expect(sql).toContain("missing_physical_identity_candidates");
    expect(sql).toContain(NOT_FOUND_REVIEW_REASON);
    expect(sql).toContain(TRACKING_COLLISION_REVIEW_REASON);
    expect(sql).toContain("physical_owner.external_fulfillment_id");
  });

  it("classifies only aggregate rows fully covered by physical shipment siblings", async () => {
    const {
      physicalIdentityReviewCandidateSql,
      LEGACY_AGGREGATE_COVERED_REVIEW_REASON,
    } = await loadModule();
    const sql = physicalIdentityReviewCandidateSql(null, false);

    expect(sql).toContain(LEGACY_AGGREGATE_COVERED_REVIEW_REASON);
    expect(sql).toContain("legacy_aggregate_covered_candidates");
    expect(sql).toContain("covered_by_physical_shipments");
    expect(sql).toContain("physical_s.order_id = s.order_id");
    expect(sql).toContain("physical_s.status::text = 'shipped'");
    expect(sql).toContain("physical_s.external_fulfillment_id");
    expect(sql).toContain("physical_si.order_item_id = aggregate_si.order_item_id");
    expect(sql).toContain("COALESCE((\n              SELECT SUM(physical_si.qty)::int");
    expect(sql).toContain(") < aggregate_si.qty");
  });

  it("does not invent provider physical shipment ids in classifier SQL", async () => {
    const { physicalIdentityReviewCandidateSql } = await loadModule();
    const sql = physicalIdentityReviewCandidateSql(null, false);

    expect(sql).not.toContain("SET external_fulfillment_id");
    expect(sql).not.toContain("shipstation_order_id::text AS provider_physical_shipment_id");
    expect(sql).not.toContain("engine_order_ref AS provider_physical_shipment_id");
  });
});
