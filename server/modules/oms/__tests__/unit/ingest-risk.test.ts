/**
 * Unit tests for Shopify fraud-risk extraction at OMS ingest (C22b).
 *
 * Scope: covers the pure extractor that converts a Shopify webhook
 * payload into the four `oms_orders` risk columns. No DB, no network.
 *
 * Plan: §6 Group E, Decision D3 — capture risk at ingest, no behavior
 * gating in this commit. Future commits / reports key off these
 * columns.
 *
 * Standards: coding-standards Rule #9 (happy + edge cases),
 * Rule #3 (numeric stored as string to preserve precision into the
 * pg numeric column), Rule #5 (no silent failures — null on missing /
 * malformed instead of throwing).
 */

// `oms-webhooks.ts` imports the shared db module which throws on missing
// connection-string env. We don't touch the db in these tests; provide a
// stub URL via vi.hoisted so it lands BEFORE module imports are
// evaluated. (Safe — no query is ever issued.)
import { describe, it, expect, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgres://stub:stub@localhost:5432/stub";
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { __test__ } = await import("../../oms-webhooks");
const { extractShopifyRisk } = __test__;

describe("extractShopifyRisk :: modern risk_assessments payload", () => {
  it("populates all four fields from a single assessment", () => {
    const payload = {
      risk_assessments: [
        {
          risk_level: "HIGH",
          recommendation: "INVESTIGATE",
          score: 0.87,
          facts: [{ description: "Shipping address differs from billing" }],
        },
      ],
    };

    const out = extractShopifyRisk(payload);

    expect(out.riskLevel).toBe("high");
    expect(out.riskRecommendation).toBe("investigate");
    expect(out.riskScore).toBe("0.87");
    // riskFacts mirrors the entire assessments array for audit (Rule #8).
    expect(out.riskFacts).toBe(payload.risk_assessments);
  });

  it("picks the highest-severity assessment when multiple are present", () => {
    const payload = {
      risk_assessments: [
        { risk_level: "LOW", recommendation: "ACCEPT", score: 0.05 },
        { risk_level: "HIGH", recommendation: "CANCEL", score: 0.92 },
        { risk_level: "MEDIUM", recommendation: "INVESTIGATE", score: 0.5 },
      ],
    };

    const out = extractShopifyRisk(payload);

    expect(out.riskLevel).toBe("high");
    expect(out.riskRecommendation).toBe("cancel");
    expect(out.riskScore).toBe("0.92");
    expect(out.riskFacts).toEqual(payload.risk_assessments);
  });

  it("accepts numeric scores given as strings (defensive parse)", () => {
    const payload = {
      risk_assessments: [{ risk_level: "MEDIUM", score: "0.42" }],
    };

    const out = extractShopifyRisk(payload);

    expect(out.riskLevel).toBe("medium");
    expect(out.riskScore).toBe("0.42");
  });

  it("returns null score when the field is non-numeric", () => {
    const payload = {
      risk_assessments: [
        { risk_level: "LOW", recommendation: "ACCEPT", score: "n/a" },
      ],
    };

    const out = extractShopifyRisk(payload);

    expect(out.riskLevel).toBe("low");
    expect(out.riskScore).toBeNull();
  });

  it("normalizes level + recommendation to lowercase regardless of input casing", () => {
    const payload = {
      risk_assessments: [
        { risk_level: "  Medium ", recommendation: " Investigate " },
      ],
    };

    const out = extractShopifyRisk(payload);

    expect(out.riskLevel).toBe("medium");
    expect(out.riskRecommendation).toBe("investigate");
  });
});

describe("extractShopifyRisk :: legacy risk object payload", () => {
  it("populates level + recommendation, leaving score null", () => {
    const payload = {
      risk: { level: "MEDIUM", recommendation: "INVESTIGATE" },
    };

    const out = extractShopifyRisk(payload);

    expect(out.riskLevel).toBe("medium");
    expect(out.riskRecommendation).toBe("investigate");
    expect(out.riskScore).toBeNull();
    expect(out.riskFacts).toEqual(payload.risk);
  });

  it("captures legacy score when present and numeric", () => {
    const payload = { risk: { level: "HIGH", score: 0.71 } };

    const out = extractShopifyRisk(payload);

    expect(out.riskLevel).toBe("high");
    expect(out.riskScore).toBe("0.71");
    expect(out.riskRecommendation).toBeNull();
  });
});

describe("extractShopifyRisk :: missing / malformed data", () => {
  it("returns all-null when the payload has no risk fields", () => {
    const out = extractShopifyRisk({ id: 123, name: "#1001" });

    expect(out).toEqual({
      riskLevel: null,
      riskScore: null,
      riskRecommendation: null,
      riskFacts: null,
    });
  });

  it("returns all-null when risk_assessments is an empty array", () => {
    // Shopify returns an empty array on orders that have not yet been
    // assessed. Without entries we have nothing to record.
    const out = extractShopifyRisk({ risk_assessments: [] });

    expect(out).toEqual({
      riskLevel: null,
      riskScore: null,
      riskRecommendation: null,
      riskFacts: null,
    });
  });

  it("does not throw on malformed risk_assessments entries", () => {
    const payload = {
      risk_assessments: [
        null,
        "not-an-object",
        { risk_level: 42 }, // wrong type
        { risk_level: "low" }, // valid, fallback level
      ],
    };

    const out = extractShopifyRisk(payload);

    // Only the valid entry contributes a level; it becomes the best.
    expect(out.riskLevel).toBe("low");
    expect(out.riskScore).toBeNull();
    expect(out.riskRecommendation).toBeNull();
    // riskFacts still exposes the raw array for audit.
    expect(out.riskFacts).toBe(payload.risk_assessments);
  });

  it("returns all-null on a fully malformed legacy risk object", () => {
    const out = extractShopifyRisk({ risk: { level: 99, recommendation: null } });

    expect(out).toEqual({
      riskLevel: null,
      riskScore: null,
      riskRecommendation: null,
      riskFacts: null,
    });
  });

  it("treats null / non-object input defensively", () => {
    expect(extractShopifyRisk(null)).toEqual({
      riskLevel: null,
      riskScore: null,
      riskRecommendation: null,
      riskFacts: null,
    });
    expect(extractShopifyRisk(undefined)).toEqual({
      riskLevel: null,
      riskScore: null,
      riskRecommendation: null,
      riskFacts: null,
    });
    expect(extractShopifyRisk("not an order")).toEqual({
      riskLevel: null,
      riskScore: null,
      riskRecommendation: null,
      riskFacts: null,
    });
  });
});
