import { describe, expect, it } from "vitest";
import type { CostApplicationEvidence, CostComponent, CostSourceRevision } from "@shared/procurement/cost-source-contracts";
import {
  allocateCostByBasePieceInterval,
  allocateSignedCostLayers,
  CostApplicationDomainError,
  deriveCostReadiness,
  exactCostTotalFromUnitAndRemainder,
  projectCostForFrozenLot,
  replaceCostComponent,
} from "../../domain/cost-application.domain";

function source(overrides: Partial<CostSourceRevision> = {}): CostSourceRevision {
  return {
    contractVersion: 1, revision: 2, fingerprint: "a".repeat(64), component: "product",
    scope: { kind: "purchase_order_line", purchaseOrderId: 1, purchaseOrderLineId: 2 },
    sources: [{ kind: "purchase_order_line", documentId: 1, lineId: 2, version: "b".repeat(64) }],
    currency: "USD", totalMills: 1_000_000, basePieces: 150, evidence: "confirmed",
    packagingTreatment: "separate", issue: null, manualOverride: null, ...overrides,
  };
}

function application(overrides: Partial<CostApplicationEvidence> = {}): CostApplicationEvidence {
  return {
    inventoryLotId: 10, component: "product", sourceRevision: 2, sourceFingerprint: "a".repeat(64),
    applicationVersion: 1, state: "applied", issue: null, ...overrides,
  };
}

describe("exact source interval allocation", () => {
  it("preserves exact totals over split receipts and exposes each sub-mill residual", () => {
    const parts = [0, 50, 100].map((startBasePiece) => allocateCostByBasePieceInterval({
      totalMills: 1_000_000, basePieces: 150, startBasePiece, quantityBasePieces: 50,
    }));
    expect(parts.map((part) => part.allocatedMills)).toEqual([333_333, 333_333, 333_334]);
    expect(parts.map((part) => part.exact.remainderNumerator)).toEqual(["50", "50", "-100"]);
    expect(parts.reduce((sum, part) => sum + part.allocatedMills, 0)).toBe(1_000_000);
  });

  it("uses original offsets rather than arrival order and remains stable when intervals split", () => {
    const original = allocateCostByBasePieceInterval({ totalMills: 101, basePieces: 7, startBasePiece: 2, quantityBasePieces: 4 });
    const later = allocateCostByBasePieceInterval({ totalMills: 101, basePieces: 7, startBasePiece: 4, quantityBasePieces: 2 });
    const earlier = allocateCostByBasePieceInterval({ totalMills: 101, basePieces: 7, startBasePiece: 2, quantityBasePieces: 2 });
    expect(later.allocatedMills + earlier.allocatedMills).toBe(original.allocatedMills);
  });

  it("preserves signed credits and exact partition conservation across deterministic edge combinations", () => {
    for (let totalMills = -31; totalMills <= 31; totalMills += 1) {
      for (let basePieces = 1; basePieces <= 11; basePieces += 1) {
        let sum = BigInt(0);
        for (let startBasePiece = 0; startBasePiece < basePieces; startBasePiece += 1) {
          const part = allocateCostByBasePieceInterval({ totalMills, basePieces, startBasePiece, quantityBasePieces: 1 });
          const positive = allocateCostByBasePieceInterval({ totalMills: Math.abs(totalMills), basePieces, startBasePiece, quantityBasePieces: 1 });
          expect(BigInt(part.exact.numerator)).toBe(BigInt(part.allocatedMills) * BigInt(part.exact.denominator) + BigInt(part.exact.remainderNumerator));
          expect(part.allocatedMills).toBe(totalMills < 0 ? -positive.allocatedMills || 0 : positive.allocatedMills);
          sum += BigInt(part.allocatedMills);
        }
        expect(sum).toBe(BigInt(totalMills));
      }
    }
  });

  it("keeps BigInt multiplication exact when intermediate values exceed Number.MAX_SAFE_INTEGER", () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    const result = allocateCostByBasePieceInterval({ totalMills: maximum, basePieces: maximum, startBasePiece: 0, quantityBasePieces: maximum });
    expect(result.allocatedMills).toBe(maximum);
    expect(result.exact.numerator).toBe((BigInt(maximum) * BigInt(maximum)).toString());
    expect(result.exact.remainderNumerator).toBe("0");
  });

  it("permits a zero interval at the boundary but rejects over-coverage", () => {
    expect(allocateCostByBasePieceInterval({ totalMills: -1, basePieces: 2, startBasePiece: 2, quantityBasePieces: 0 }).allocatedMills).toBe(0);
    expect(() => allocateCostByBasePieceInterval({ totalMills: 1, basePieces: 2, startBasePiece: 2, quantityBasePieces: 1 })).toThrow(expect.objectContaining({ code: "COST_INTERVAL_OUT_OF_BOUNDS" }));
  });

  it.each([null, true, "100", 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects non-integer numeric input without coercion: %s", (totalMills) => {
    expect(() => allocateCostByBasePieceInterval({ totalMills, basePieces: 2, startBasePiece: 0, quantityBasePieces: 1 } as never)).toThrow(CostApplicationDomainError);
  });

  it("rejects zero denominators and negative source offsets", () => {
    expect(() => allocateCostByBasePieceInterval({ totalMills: 1, basePieces: 0, startBasePiece: 0, quantityBasePieces: 0 })).toThrow(expect.objectContaining({ code: "INVALID_COST_CONTRACT" }));
    expect(() => allocateCostByBasePieceInterval({ totalMills: 1, basePieces: 2, startBasePiece: -1, quantityBasePieces: 1 })).toThrow(CostApplicationDomainError);
  });
});

describe("frozen lot components and residuals", () => {
  it("keeps the exact extended remainder that a uniform lot unit cannot represent", () => {
    const lot = projectCostForFrozenLot({ totalMills: 1_000_000, basePieces: 150, startBasePiece: 0, lotQuantity: 3, unitsPerVariantSnapshot: 50 });
    expect(lot).toMatchObject({ quantityBasePieces: 150, allocatedMills: 1_000_000, unitMills: 333_333, remainderMills: 1 });
    expect(lot.unitMills * lot.lotQuantity + lot.remainderMills).toBe(1_000_000);
    const credit = projectCostForFrozenLot({ totalMills: -1_000_001, basePieces: 150, startBasePiece: 0, lotQuantity: 3, unitsPerVariantSnapshot: 50 });
    expect(credit.unitMills).toBe(-333_334);
    expect(credit.remainderMills).toBe(1);
  });

  it("allocates product and packaging separately, without pre-rounding the base-piece quote", () => {
    const layers = allocateSignedCostLayers({ productMills: 1_000_000, packagingMills: 180_000, landedMills: 300_001 }, 3);
    const sum = (field: "productMills" | "packagingMills" | "landedMills" | "totalMills") => layers.reduce((total, layer) => total + layer[field] * layer.qty, 0);
    expect(layers.reduce((total, layer) => total + layer.qty, 0)).toBe(3);
    expect(sum("productMills")).toBe(1_000_000);
    expect(sum("packagingMills")).toBe(180_000);
    expect(sum("landedMills")).toBe(300_001);
    expect(sum("totalMills")).toBe(1_480_001);
  });

  it("conserves positive and negative component layers independently", () => {
    for (let quantity = 1; quantity <= 13; quantity += 1) {
      for (let amount = -20; amount <= 20; amount += 1) {
        const totals = { productMills: amount, packagingMills: -amount + 3, landedMills: amount * 2 - 1 };
        const layers = allocateSignedCostLayers(totals, quantity);
        expect(layers.length).toBeLessThanOrEqual(4);
        expect(layers.reduce((sum, layer) => sum + layer.qty, 0)).toBe(quantity);
        for (const field of ["productMills", "packagingMills", "landedMills"] as const) {
          expect(layers.reduce((sum, layer) => sum + BigInt(layer[field]) * BigInt(layer.qty), BigInt(0))).toBe(BigInt(totals[field]));
        }
        for (const layer of layers) expect(layer.totalMills).toBe(layer.productMills + layer.packagingMills + layer.landedMills);
      }
    }
  });

  it("rejects invalid pack factors, quantity overflow and aggregate unit overflow", () => {
    expect(() => projectCostForFrozenLot({ totalMills: 1, basePieces: 2, startBasePiece: 0, lotQuantity: 1, unitsPerVariantSnapshot: 0 })).toThrow(CostApplicationDomainError);
    expect(() => projectCostForFrozenLot({ totalMills: 1, basePieces: Number.MAX_SAFE_INTEGER, startBasePiece: 0, lotQuantity: Number.MAX_SAFE_INTEGER, unitsPerVariantSnapshot: 2 })).toThrow(expect.objectContaining({ code: "COST_QUANTITY_OVERFLOW" }));
    expect(() => allocateSignedCostLayers({ productMills: Number.MAX_SAFE_INTEGER, packagingMills: 1, landedMills: 0 }, 1)).toThrow(expect.objectContaining({ code: "COST_AMOUNT_OVERFLOW" }));
    expect(() => allocateSignedCostLayers({ productMills: 1, packagingMills: 0, landedMills: 0 }, 0)).toThrow(CostApplicationDomainError);
  });

  it("reconstructs exact quote mills from the signed normalization remainder", () => {
    expect(exactCostTotalFromUnitAndRemainder({ unitMills: 6_667, basePieces: 150, remainderMills: -50 })).toBe(1_000_000);
    expect(exactCostTotalFromUnitAndRemainder({ unitMills: 375, basePieces: 3, remainderMills: 0 })).toBe(1_125);
    expect(exactCostTotalFromUnitAndRemainder({ unitMills: Number.MAX_SAFE_INTEGER, basePieces: 2, remainderMills: -Number.MAX_SAFE_INTEGER })).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => exactCostTotalFromUnitAndRemainder({ unitMills: Number.MAX_SAFE_INTEGER, basePieces: 2, remainderMills: 0 })).toThrow(expect.objectContaining({ code: "COST_AMOUNT_OVERFLOW" }));
  });

  it.each<CostComponent>(["product", "packaging", "landed"])("replaces only %s authority without mutating current components", (component) => {
    const current = Object.freeze({ productMills: 100, packagingMills: 20, landedMills: 30 });
    const result = replaceCostComponent({ current, component, unitMills: -5 });
    for (const field of ["product", "packaging", "landed"] as const) {
      expect(result[`${field}Mills`]).toBe(field === component ? -5 : current[`${field}Mills`]);
    }
    expect(current).toEqual({ productMills: 100, packagingMills: 20, landedMills: 30 });
    expect(result.totalMills).toBe(result.productMills + result.packagingMills + result.landedMills);
  });
});

describe("source readiness remains distinct from application history", () => {
  it("requires the current fingerprint and revision for applied status", () => {
    expect(deriveCostReadiness({ source: source(), application: null, lineage: "proven" }).state).toBe("ready_to_apply");
    expect(deriveCostReadiness({ source: source(), application: application(), lineage: "proven" })).toMatchObject({ state: "applied", currentRevisionApplied: true });
    for (const prior of [application({ sourceRevision: 1 }), application({ sourceFingerprint: "c".repeat(64) })]) {
      expect(deriveCostReadiness({ source: source(), application: prior, lineage: "proven" })).toMatchObject({ state: "ready_to_apply", currentRevisionApplied: false, applicationState: "applied" });
    }
  });

  it("keeps applied estimates provisional and an explicit confirmed zero ready", () => {
    expect(deriveCostReadiness({ source: source({ evidence: "estimated" }), application: application(), lineage: "proven" })).toMatchObject({ state: "estimated", currentRevisionApplied: true });
    expect(deriveCostReadiness({ source: source({ totalMills: 0 }), application: null, lineage: "proven" }).state).toBe("ready_to_apply");
    expect(deriveCostReadiness({ source: source({ evidence: "unknown", totalMills: null, basePieces: null, issue: { code: "SOURCE_MISSING", message: "Obtain the vendor evidence." } }), application: null, lineage: "proven" }).state).toBe("awaiting_source");
  });

  it.each([null, "EUR"])("preserves %s currency for review without claiming a conversion", (currency) => {
    const revision = source({ currency });
    expect(deriveCostReadiness({ source: revision, application: null, lineage: "proven" })).toMatchObject({ state: "review_required", issues: [expect.objectContaining({ code: "COST_CURRENCY_REVIEW_REQUIRED" })] });
    expect(revision.currency).toBe(currency);
  });

  it.each(["missing", "conflicting"] as const)("requires review for %s contribution lineage", (lineage) => {
    expect(deriveCostReadiness({ source: source(), application: application(), lineage }).state).toBe("review_required");
  });

  it.each(["unknown", "included_in_product"] as const)("requires product/packaging review for %s treatment without blocking independent freight", (packagingTreatment) => {
    expect(deriveCostReadiness({ source: source({ packagingTreatment }), application: null, lineage: "proven" }).state).toBe("review_required");
    expect(deriveCostReadiness({ source: source({ component: "landed", packagingTreatment }), application: null, lineage: "proven" }).state).toBe("ready_to_apply");
  });

  it("retains signed credits and reports an unsupported negative net component", () => {
    const revision = source({ component: "landed", totalMills: -30_000 });
    expect(deriveCostReadiness({ source: revision, application: null, lineage: "proven" })).toMatchObject({ state: "review_required", issues: [expect.objectContaining({ code: "COST_NEGATIVE_COMPONENT_UNSUPPORTED" })] });
    expect(revision.totalMills).toBe(-30_000);
  });

  it("shows current application failures, but does not apply a superseded failure to a new revision", () => {
    const issue = { code: "COST_WRITE_FAILED", message: "Retry the rolled-back application." };
    expect(deriveCostReadiness({ source: source(), application: application({ state: "retry_required", issue }), lineage: "proven" })).toMatchObject({ state: "retry_required", issues: [issue] });
    expect(deriveCostReadiness({ source: source(), application: application({ state: "retry_required", sourceRevision: 1, issue }), lineage: "proven" }).state).toBe("ready_to_apply");
    expect(deriveCostReadiness({ source: source(), application: application({ state: "review_required", issue }), lineage: "proven" }).state).toBe("review_required");
  });

  it("retains explicit source review and rejects a mismatched component application", () => {
    expect(deriveCostReadiness({ source: source({ evidence: "review_required", issue: { code: "SOURCE_CONFLICT", message: "Review competing source revisions." } }), application: null, lineage: "proven" }).state).toBe("review_required");
    expect(deriveCostReadiness({ source: source(), application: application({ component: "landed" }), lineage: "proven" })).toMatchObject({ state: "review_required", currentRevisionApplied: false, issues: [expect.objectContaining({ code: "COST_APPLICATION_COMPONENT_MISMATCH" })] });
  });
});
