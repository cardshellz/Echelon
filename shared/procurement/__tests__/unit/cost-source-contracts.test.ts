import { describe, expect, it } from "vitest";
import {
  costApplicationEvidenceSchema,
  costSourceRevisionSchema,
  type CostSourceRevision,
} from "../../cost-source-contracts";

function revision(overrides: Partial<CostSourceRevision> = {}): CostSourceRevision {
  return {
    contractVersion: 1,
    revision: 1,
    fingerprint: "a".repeat(64),
    component: "product",
    scope: { kind: "purchase_order_line", purchaseOrderId: 1, purchaseOrderLineId: 2 },
    sources: [{ kind: "purchase_order_line", documentId: 1, lineId: 2, version: "b".repeat(64) }],
    currency: "USD",
    totalMills: 1_000_000,
    basePieces: 150,
    evidence: "confirmed",
    packagingTreatment: "separate",
    issue: null,
    manualOverride: null,
    ...overrides,
  };
}

describe("immutable cost source contracts", () => {
  it("keeps confirmed zero, signed credits, unknown currency and source versions distinct", () => {
    for (const totalMills of [0, -1, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]) {
      const parsed = costSourceRevisionSchema.parse(revision({ totalMills, currency: null }));
      expect(parsed.totalMills).toBe(totalMills);
      expect(parsed.currency).toBeNull();
      expect(parsed.sources[0].version).toBe("b".repeat(64));
    }
    expect(costSourceRevisionSchema.parse(revision({ currency: "EUR" })).currency).toBe("EUR");
  });

  it.each([null, true, "100", 1.1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid known amounts without coercion: %s", (totalMills) => {
      expect(costSourceRevisionSchema.safeParse({ ...revision(), totalMills }).success).toBe(false);
    },
  );

  it("requires explicit reasons for unknown and review evidence without fabricating zero", () => {
    const unknown = revision({ evidence: "unknown", totalMills: null, basePieces: null });
    expect(costSourceRevisionSchema.safeParse(unknown).success).toBe(false);
    const parsed = costSourceRevisionSchema.parse({ ...unknown, issue: { code: "SOURCE_AMOUNT_UNKNOWN", message: "Obtain the source amount." } });
    expect(parsed.totalMills).toBeNull();
    expect(parsed.basePieces).toBeNull();
    expect(costSourceRevisionSchema.safeParse(revision({ evidence: "review_required" })).success).toBe(false);
  });

  it.each([0, -1, 1.5, "150", true, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid source denominators: %s", (basePieces) => {
      expect(costSourceRevisionSchema.safeParse({ ...revision(), basePieces }).success).toBe(false);
    },
  );

  it("requires exact shipment identity and rejects unknown fields and invalid fingerprints", () => {
    const shipment = revision({ scope: { kind: "shipment_line", purchaseOrderId: 1, purchaseOrderLineId: 2, inboundShipmentId: 3, inboundShipmentLineId: 4 } });
    expect(costSourceRevisionSchema.parse(shipment).scope).toEqual(shipment.scope);
    expect(costSourceRevisionSchema.safeParse({ ...shipment, scope: { ...shipment.scope, inboundShipmentLineId: null } }).success).toBe(false);
    expect(costSourceRevisionSchema.safeParse({ ...revision(), guessedOverride: true }).success).toBe(false);
    expect(costSourceRevisionSchema.safeParse(revision({ fingerprint: "mutable-row-2" })).success).toBe(false);
    expect(costSourceRevisionSchema.safeParse(revision({ currency: "usd" })).success).toBe(false);
  });

  it("requires explicit actor, reason, timestamp and versioned reference for an override", () => {
    const manual = revision({ sources: [{ kind: "manual_override", documentId: 3, lineId: 4, version: "c".repeat(64) }] });
    expect(costSourceRevisionSchema.safeParse(manual).success).toBe(false);
    const provenance = { actorId: "operator-1", reason: "Approved revised component quote", recordedAt: "2026-09-07T12:00:00Z" };
    expect(costSourceRevisionSchema.parse({ ...manual, manualOverride: provenance }).manualOverride).toEqual(provenance);
    expect(costSourceRevisionSchema.safeParse(revision({ manualOverride: provenance })).success).toBe(false);
    expect(costSourceRevisionSchema.safeParse({ ...manual, manualOverride: { ...provenance, reason: " " } }).success).toBe(false);
  });

  it("rejects duplicate source lines even when the duplicate claims a new version", () => {
    const source = revision();
    source.sources.push({ ...source.sources[0], version: "c".repeat(64) });
    expect(costSourceRevisionSchema.safeParse(source).success).toBe(false);
  });

  it("requires persisted application identity and explicit failure evidence", () => {
    const application = {
      inventoryLotId: 1, component: "product", sourceRevision: 1, sourceFingerprint: "a".repeat(64),
      applicationVersion: 0, state: "pending", issue: null,
    };
    expect(costApplicationEvidenceSchema.safeParse(application).success).toBe(true);
    expect(costApplicationEvidenceSchema.safeParse({ ...application, state: "applied" }).success).toBe(false);
    expect(costApplicationEvidenceSchema.safeParse({ ...application, state: "applied", applicationVersion: 1 }).success).toBe(true);
    expect(costApplicationEvidenceSchema.safeParse({ ...application, state: "retry_required" }).success).toBe(false);
    expect(costApplicationEvidenceSchema.safeParse({ ...application, state: "review_required" }).success).toBe(false);
    expect(costApplicationEvidenceSchema.safeParse({ ...application, state: "retry_required", issue: { code: "COST_WRITE_FAILED", message: "Retry the rolled-back application." } }).success).toBe(true);
  });
});
