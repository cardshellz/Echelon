import { describe, expect, it } from "vitest";
import {
  HISTORICAL_COST_EVIDENCE_ORDER_POLICY,
  HistoricalCostEvidenceOrderError,
  orderHistoricalCostEvidence,
  type HistoricalCostEvidenceOrderInput,
} from "../../domain/historical-cost-evidence-order";

describe("historical cost evidence ordering", () => {
  it("preserves microsecond order beyond Number's exact integer range", () => {
    const result = orderHistoricalCostEvidence([
      { kind: "cogs", id: 2, timestampMicros: "9007199254740993" },
      { kind: "operation", id: 1, timestampMicros: "9007199254740992" },
    ]);
    expect(result.map(row => row.kind)).toEqual(["operation", "cogs"]);
    expect(result.map(row => row.timestampMicros)).toEqual(["9007199254740992", "9007199254740993"]);
  });

  it("uses kind and numeric source ID only when exact timestamps tie", () => {
    const result = orderHistoricalCostEvidence([
      { kind: "reversal", id: 1, timestampMicros: "1200" },
      { kind: "operation", id: 1, timestampMicros: "1200" },
      { kind: "cogs", id: 10, timestampMicros: "1200" },
      { kind: "cogs", id: 2, timestampMicros: "1200" },
    ]);
    expect(result.map(row => `${row.kind}:${row.id}`)).toEqual(["cogs:2", "cogs:10", "operation:1", "reversal:1"]);
  });

  it("orders pre-epoch evidence and retains a JSON-safe exact coordinate", () => {
    const result = orderHistoricalCostEvidence([
      { kind: "cogs", id: 1, timestampMicros: "0" },
      { kind: "operation", id: 2, timestampMicros: "-0002" },
      { kind: "cogs", id: 3, timestampMicros: "-1" },
    ]);
    expect(result.map(row => row.timestampMicros)).toEqual(["-2", "-1", "0"]);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("does not mutate its input or lose source identity and payload", () => {
    const original = Object.freeze([
      Object.freeze({ kind: "cogs" as const, id: 4, timestampMicros: "3", source: "original-cogs" }),
      Object.freeze({ kind: "operation" as const, id: 7, timestampMicros: "2", source: "original-operation" }),
    ]);
    const result = orderHistoricalCostEvidence(original);
    expect(original.map(row => row.id)).toEqual([4, 7]);
    expect(result.map(row => row.source)).toEqual(["original-operation", "original-cogs"]);
    expect(result[0]).not.toBe(original[1]);
    expect(HISTORICAL_COST_EVIDENCE_ORDER_POLICY).toBe("stable_recorded_evidence_order_v2");
  });

  it.each([null, undefined, "", " ", "Infinity", "-Infinity", "NaN", "1.2", "1e3", "12x", 123, new Date("2026-10-05T14:54:13.394Z")])(
    "rejects non-integer or non-finite timestamp evidence %s",
    timestampMicros => {
      const input: HistoricalCostEvidenceOrderInput = { kind: "cogs", id: 18251, timestampMicros };
      expect(() => orderHistoricalCostEvidence([input])).toThrow(HistoricalCostEvidenceOrderError);
      expect(() => orderHistoricalCostEvidence([input])).toThrow(expect.objectContaining({
        code: "COST_HISTORICAL_TIMESTAMP_INVALID", sourceKind: "cogs", sourceId: 18251,
      }));
    },
  );

  it("rejects invalid evidence even when it would be the only candidate", () => {
    expect(() => orderHistoricalCostEvidence([
      { kind: "operation", id: 12, timestampMicros: "Infinity" },
    ])).toThrow(HistoricalCostEvidenceOrderError);
    expect(orderHistoricalCostEvidence([])).toEqual([]);
  });
});
