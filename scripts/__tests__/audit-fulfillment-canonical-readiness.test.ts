import { describe, expect, it } from "vitest";

async function loadAuditModule() {
  process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
  return await import("../audit-fulfillment-canonical-readiness");
}

describe("audit-fulfillment-canonical-readiness", () => {
  it("parses CLI flags with safe read-only defaults", async () => {
    const { parseFlags } = await loadAuditModule();

    expect(parseFlags([])).toEqual({
      help: false,
      json: false,
      failOnIssues: false,
      sampleLimit: 10,
      checkId: null,
    });

    expect(parseFlags([
      "--json",
      "--fail-on-issues",
      "--limit=all",
      "--check=shipped_missing_physical_identity",
    ])).toEqual({
      help: false,
      json: true,
      failOnIssues: true,
      sampleLimit: "all",
      checkId: "shipped_missing_physical_identity",
    });
  });

  it("rejects invalid CLI input instead of silently choosing a fallback", async () => {
    const { parseFlags } = await loadAuditModule();

    expect(() => parseFlags(["--limit=0"])).toThrow(/positive integer or all/);
    expect(() => parseFlags(["--limit=abc"])).toThrow(/positive integer or all/);
    expect(() => parseFlags(["--check="])).toThrow(/cannot be blank/);
    expect(() => parseFlags(["--operations=all"])).toThrow(/Unknown flag/);
  });

  it("defines checks for canonical fulfillment shadow-table backfill readiness", async () => {
    const { buildCanonicalReadinessChecks } = await loadAuditModule();
    const checks = buildCanonicalReadinessChecks();
    const ids = checks.map((check) => check.id);

    expect(ids).toEqual([
      "shipment_item_missing_authority_line",
      "shipment_item_order_mismatch",
      "nonpositive_shipment_item_quantity",
      "duplicate_physical_shipment_identity",
      "shipped_missing_physical_identity",
      "shipped_physical_identity_review_exception",
      "provider_order_identity_collision",
      "shopify_shipped_without_channel_fulfillment_id",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(checks.every((check) => check.canonicalTarget.length > 0)).toBe(true);
  });

  it("keeps the audit SQL read-only", async () => {
    const { buildCanonicalReadinessChecks } = await loadAuditModule();
    const mutatingSqlPattern = /\b(insert|update|delete|merge|alter|create|drop|truncate|grant|revoke)\b/i;

    for (const check of buildCanonicalReadinessChecks()) {
      expect(check.sql, check.id).not.toMatch(mutatingSqlPattern);
    }
  });

  it("uses actual WMS order and shipment column names", async () => {
    const { buildCanonicalReadinessChecks } = await loadAuditModule();

    for (const check of buildCanonicalReadinessChecks()) {
      expect(check.sql, check.id).not.toContain("o.status");
      expect(check.sql, check.id).toContain("warehouse_status");
      expect(check.sql, check.id).toContain("s.status");
      expect(check.sql, check.id).not.toContain("s.order_number");
    }
  });

  it("casts shipment status enums to text before blank fallbacks", async () => {
    const { buildCanonicalReadinessChecks } = await loadAuditModule();
    const allSql = buildCanonicalReadinessChecks()
      .map((check) => check.sql)
      .join("\n");

    expect(allSql).not.toContain("COALESCE(s.status, '')");
    expect(allSql).not.toContain("s.status = 'shipped'");
    expect(allSql).toContain("COALESCE(s.status::text, '')");
    expect(allSql).toContain("s.status::text = 'shipped'");
  });

  it("does not invent physical shipment identities from provider order ids", async () => {
    const { buildCanonicalReadinessChecks } = await loadAuditModule();
    const physicalIdentityChecks = buildCanonicalReadinessChecks()
      .filter((check) =>
        check.id === "duplicate_physical_shipment_identity" ||
        check.id === "shipped_missing_physical_identity"
      );

    expect(physicalIdentityChecks.length).toBe(2);
    for (const check of physicalIdentityChecks) {
      expect(check.sql, check.id).toContain("external_fulfillment_id");
      expect(check.sql, check.id).not.toContain("shipstation_order_id::text AS provider_physical_shipment_id");
      expect(check.sql, check.id).not.toContain("engine_order_ref AS provider_physical_shipment_id");
    }
  });

  it("does not double-count duplicate rows already represented by a sibling physical shipment id", async () => {
    const { buildCanonicalReadinessChecks } = await loadAuditModule();
    const missingPhysicalIdentityCheck = buildCanonicalReadinessChecks()
      .find((check) => check.id === "shipped_missing_physical_identity");

    expect(missingPhysicalIdentityCheck).toBeDefined();
    expect(missingPhysicalIdentityCheck!.sql).toContain("NOT EXISTS");
    expect(missingPhysicalIdentityCheck!.sql).toContain("sibling.shipstation_order_id = s.shipstation_order_id");
    expect(missingPhysicalIdentityCheck!.sql).toContain("sibling.tracking_number");
    expect(missingPhysicalIdentityCheck!.sql).toContain("sibling.external_fulfillment_id");
  });

  it("keeps classified physical identity review exceptions out of blockers", async () => {
    const { buildCanonicalReadinessChecks } = await loadAuditModule();
    const checks = buildCanonicalReadinessChecks();
    const blocker = checks.find((check) => check.id === "shipped_missing_physical_identity");
    const reviewWarning = checks.find((check) => check.id === "shipped_physical_identity_review_exception");

    expect(blocker).toBeDefined();
    expect(reviewWarning).toBeDefined();
    expect(blocker!.severity).toBe("blocker");
    expect(reviewWarning!.severity).toBe("warning");
    expect(blocker!.sql).toContain("COALESCE(s.requires_review, false) = false");
    expect(reviewWarning!.sql).toContain("COALESCE(s.requires_review, false) = true");
  });

  it("separates blockers from warnings in the summary", async () => {
    const { buildCanonicalReadinessChecks, summarizeCanonicalResults } = await loadAuditModule();
    const checks = buildCanonicalReadinessChecks();
    const blocker = checks.find((check) => check.severity === "blocker");
    const warning = checks.find((check) => check.severity === "warning");

    expect(blocker).toBeDefined();
    expect(warning).toBeDefined();

    const summary = summarizeCanonicalResults([
      { check: blocker!, count: 2, samples: [] },
      { check: warning!, count: 3, samples: [] },
    ]);

    expect(summary).toEqual({
      checks: 2,
      blockers: 2,
      warnings: 3,
      issueCount: 5,
    });
  });
});
