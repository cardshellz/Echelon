import { describe, expect, it } from "vitest";
import { resolvePurchasingForwardDemandContributionCapture } from "../../purchasing-forward-demand-contribution";

const confidenceWeights = { high: 100, medium: 70, low: 40 };

function contribution(overrides: Record<string, unknown> = {}) {
  return {
    productId: 10,
    productVariantId: null,
    demandEventId: 700,
    demandEventLineId: 701,
    eventName: "Promotion",
    eventType: "promotion",
    eventStatus: "planned",
    eventStartDate: "2026-08-01",
    eventEndDate: null,
    planningAsOfDate: "2026-07-24",
    expectedPieces: 250,
    confidence: "medium",
    confidenceWeightPercent: 70,
    weightedPieces: 175,
    eventUpdatedAt: "2026-07-23T10:00:00.000Z",
    lineUpdatedAt: "2026-07-23T10:05:00.000Z",
    ...overrides,
  };
}

describe("purchasing forward-demand contribution capture", () => {
  it("returns complete, normalized evidence when every aggregate reconciles", () => {
    const result = resolvePurchasingForwardDemandContributionCapture({
      rawContributions: JSON.stringify([contribution()]),
      rawPlanningAsOfDate: "2026-07-24",
      rawHorizonDays: 90,
      enabled: true,
      productId: 10,
      forwardDemandPieces: 175,
      forwardDemandRawPieces: 250,
      forwardDemandEventCount: 1,
      confidenceWeights,
    });

    expect(result).toMatchObject({
      overlayCaptureVersion: 2,
      overlayCaptureComplete: true,
      overlayPlanningAsOfDate: "2026-07-24",
      overlayHorizonDays: 90,
      contributions: [{ demandEventLineId: 701, weightedPieces: 175 }],
    });
  });

  it("marks omitted legacy evidence incomplete instead of treating it as an empty overlay", () => {
    expect(resolvePurchasingForwardDemandContributionCapture({
      rawContributions: undefined,
      rawPlanningAsOfDate: undefined,
      rawHorizonDays: undefined,
      enabled: true,
      productId: 10,
      forwardDemandPieces: 0,
      forwardDemandRawPieces: 0,
      forwardDemandEventCount: 0,
      confidenceWeights,
    })).toEqual({
      overlayCaptureVersion: 0,
      overlayCaptureComplete: false,
      overlayPlanningAsOfDate: null,
      overlayHorizonDays: null,
      contributions: [],
    });
  });

  it("rejects duplicate source line identities", () => {
    expect(() => resolvePurchasingForwardDemandContributionCapture({
      rawContributions: [contribution(), contribution()],
      rawPlanningAsOfDate: "2026-07-24",
      rawHorizonDays: 90,
      enabled: true,
      productId: 10,
      forwardDemandPieces: 350,
      forwardDemandRawPieces: 500,
      forwardDemandEventCount: 1,
      confidenceWeights,
    })).toThrow("duplicate demand event line 701");
  });

  it("rejects a captured weight that differs from the active policy", () => {
    expect(() => resolvePurchasingForwardDemandContributionCapture({
      rawContributions: [contribution({ confidenceWeightPercent: 80, weightedPieces: 200 })],
      rawPlanningAsOfDate: "2026-07-24",
      rawHorizonDays: 90,
      enabled: true,
      productId: 10,
      forwardDemandPieces: 200,
      forwardDemandRawPieces: 250,
      forwardDemandEventCount: 1,
      confidenceWeights,
    })).toThrow("does not match the active confidence weight");
  });

  it("requires parent coverage metadata for complete captures, including empty captures", () => {
    expect(() => resolvePurchasingForwardDemandContributionCapture({
      rawContributions: [],
      rawPlanningAsOfDate: undefined,
      rawHorizonDays: undefined,
      enabled: true,
      productId: 10,
      forwardDemandPieces: 0,
      forwardDemandRawPieces: 0,
      forwardDemandEventCount: 0,
      confidenceWeights,
    })).toThrow("forwardDemandPlanningAsOfDate");
  });

  it("rejects contribution rows that fall outside parent capture coverage", () => {
    expect(() => resolvePurchasingForwardDemandContributionCapture({
      rawContributions: [contribution({ eventStartDate: "2026-08-02" })],
      rawPlanningAsOfDate: "2026-07-24",
      rawHorizonDays: 8,
      enabled: true,
      productId: 10,
      forwardDemandPieces: 175,
      forwardDemandRawPieces: 250,
      forwardDemandEventCount: 1,
      confidenceWeights,
    })).toThrow("falls outside the capture horizon");
  });

  it("rejects child planning dates that differ from parent coverage", () => {
    expect(() => resolvePurchasingForwardDemandContributionCapture({
      rawContributions: [contribution({ planningAsOfDate: "2026-07-23" })],
      rawPlanningAsOfDate: "2026-07-24",
      rawHorizonDays: 90,
      enabled: true,
      productId: 10,
      forwardDemandPieces: 175,
      forwardDemandRawPieces: 250,
      forwardDemandEventCount: 1,
      confidenceWeights,
    })).toThrow("does not match the capture planning date");
  });
});
