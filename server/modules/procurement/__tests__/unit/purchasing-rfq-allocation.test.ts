import { describe, expect, it } from "vitest";
import {
  buildRfqBatchRequestHash,
  evaluateRfqAllocationOverride,
} from "../../purchasing-rfq-allocation";

const approvedAt = new Date("2026-07-21T12:00:00.000Z");

describe("RFQ allocation overrides", () => {
  it("uses the remaining recommendation without override evidence", () => {
    expect(evaluateRfqAllocationOverride({
      requestedPieces: 100,
      remainingPieces: 100,
      approvedAt,
    })).toEqual({
      ok: true,
      evidence: {
        quantityOverrideReason: null,
        allocationOverrideReason: null,
        allocationOverrideApprovedBy: null,
        allocationOverrideApprovedAt: null,
        allocationOverrideBaselinePieces: null,
        allocationOverrideExcessPieces: null,
      },
    });
  });

  it("requires a reason for a reduction and does not record approval evidence", () => {
    const missingReason = evaluateRfqAllocationOverride({
      requestedPieces: 80,
      remainingPieces: 100,
      approvedAt,
    });
    expect(missingReason).toMatchObject({
      ok: false,
      issue: { code: "RFQ_QUANTITY_REASON_REQUIRED" },
    });

    expect(evaluateRfqAllocationOverride({
      requestedPieces: 80,
      remainingPieces: 100,
      quantityOverrideReason: "Supplier minimum split",
      approvedAt,
    })).toMatchObject({
      ok: true,
      evidence: {
        quantityOverrideReason: "Supplier minimum split",
        allocationOverrideReason: null,
        allocationOverrideApprovedBy: null,
        allocationOverrideApprovedAt: null,
        allocationOverrideBaselinePieces: null,
        allocationOverrideExcessPieces: null,
      },
    });
  });

  it("requires explicit approval and an authenticated approver above remaining demand", () => {
    const base = {
      requestedPieces: 125,
      remainingPieces: 100,
      quantityOverrideReason: "Build safety stock for launch",
      approvedAt,
    };
    expect(evaluateRfqAllocationOverride(base)).toMatchObject({
      ok: false,
      issue: { code: "RFQ_ALLOCATION_OVERRIDE_APPROVAL_REQUIRED" },
    });
    expect(evaluateRfqAllocationOverride({
      ...base,
      allocationOverrideApproved: true,
    })).toMatchObject({
      ok: false,
      issue: { code: "RFQ_ALLOCATION_OVERRIDE_ACTOR_REQUIRED" },
    });

    expect(evaluateRfqAllocationOverride({
      ...base,
      allocationOverrideApproved: true,
      approvedBy: "buyer-17",
    })).toEqual({
      ok: true,
      evidence: {
        quantityOverrideReason: "Build safety stock for launch",
        allocationOverrideReason: "Build safety stock for launch",
        allocationOverrideApprovedBy: "buyer-17",
        allocationOverrideApprovedAt: approvedAt,
        allocationOverrideBaselinePieces: 100,
        allocationOverrideExcessPieces: 25,
      },
    });
  });

  it("rejects an approval flag when the request does not exceed remaining demand", () => {
    expect(evaluateRfqAllocationOverride({
      requestedPieces: 100,
      remainingPieces: 100,
      allocationOverrideApproved: true,
      approvedBy: "buyer-17",
      approvedAt,
    })).toMatchObject({
      ok: false,
      issue: { code: "RFQ_ALLOCATION_OVERRIDE_NOT_APPLICABLE" },
    });
  });

  it("hashes the exact normalized batch intent independent of line order", () => {
    const first = {
      requestNote: "Quote delivered pricing",
      responseDueDate: "2026-07-28",
      approvedBy: "buyer-17",
      lines: [
        {
          recommendationLineId: 2,
          vendorId: 20,
          vendorSku: "SUP-2",
          requestedPieces: 125,
          quantityOverrideReason: "Build safety stock for launch",
          allocationOverrideApproved: true,
        },
        {
          recommendationLineId: 1,
          vendorId: 10,
          vendorSku: null,
          requestedPieces: 50,
          quantityOverrideReason: null,
          allocationOverrideApproved: false,
        },
      ],
    };
    const hash = buildRfqBatchRequestHash(first);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(buildRfqBatchRequestHash({ ...first, lines: [...first.lines].reverse() })).toBe(hash);
    expect(buildRfqBatchRequestHash({
      ...first,
      lines: first.lines.map((line, index) => index === 0 ? { ...line, requestedPieces: 126 } : line),
    })).not.toBe(hash);
    expect(buildRfqBatchRequestHash({ ...first, approvedBy: "buyer-18" })).not.toBe(hash);
  });
});
