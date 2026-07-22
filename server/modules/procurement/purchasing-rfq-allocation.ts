import { createHash } from "node:crypto";

export interface RfqAllocationOverrideInput {
  requestedPieces: number;
  remainingPieces: number;
  quantityOverrideReason?: string | null;
  allocationOverrideApproved?: boolean;
  approvedBy?: string | null;
  approvedAt: Date;
}

export interface RfqAllocationOverrideEvidence {
  quantityOverrideReason: string | null;
  allocationOverrideReason: string | null;
  allocationOverrideApprovedBy: string | null;
  allocationOverrideApprovedAt: Date | null;
  allocationOverrideBaselinePieces: number | null;
  allocationOverrideExcessPieces: number | null;
}

export interface RfqAllocationOverrideIssue {
  code:
    | "RFQ_QUANTITY_REASON_REQUIRED"
    | "RFQ_ALLOCATION_OVERRIDE_APPROVAL_REQUIRED"
    | "RFQ_ALLOCATION_OVERRIDE_ACTOR_REQUIRED"
    | "RFQ_ALLOCATION_OVERRIDE_NOT_APPLICABLE";
  message: string;
  statusCode: number;
  context: {
    requestedPieces: number;
    remainingPieces: number;
    excessPieces: number;
  };
}

export type RfqAllocationOverrideResult =
  | { ok: true; evidence: RfqAllocationOverrideEvidence }
  | { ok: false; issue: RfqAllocationOverrideIssue };

export interface RfqBatchRequestIntent {
  requestNote: string | null;
  responseDueDate: string | null;
  approvedBy: string | null;
  lines: Array<{
    recommendationLineId: number;
    vendorId: number;
    vendorSku: string | null;
    requestedPieces: number;
    quantityOverrideReason: string | null;
    allocationOverrideApproved: boolean;
  }>;
}

export function buildRfqBatchRequestHash(input: RfqBatchRequestIntent): string {
  const canonical = {
    requestNote: input.requestNote,
    responseDueDate: input.responseDueDate,
    approvedBy: input.lines.some((line) => line.allocationOverrideApproved)
      ? input.approvedBy
      : null,
    lines: [...input.lines].sort((left, right) =>
      left.vendorId - right.vendorId
      || left.recommendationLineId - right.recommendationLineId,
    ),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function evaluateRfqAllocationOverride(
  input: RfqAllocationOverrideInput,
): RfqAllocationOverrideResult {
  const reason = input.quantityOverrideReason?.trim() || null;
  const quantityChanged = input.requestedPieces !== input.remainingPieces;
  const excessPieces = Math.max(input.requestedPieces - input.remainingPieces, 0);
  const context = {
    requestedPieces: input.requestedPieces,
    remainingPieces: input.remainingPieces,
    excessPieces,
  };

  if (quantityChanged && (reason?.length ?? 0) < 3) {
    return {
      ok: false,
      issue: {
        code: "RFQ_QUANTITY_REASON_REQUIRED",
        message: "A reason is required when changing the suggested RFQ quantity",
        statusCode: 400,
        context,
      },
    };
  }

  if (excessPieces === 0) {
    if (input.allocationOverrideApproved) {
      return {
        ok: false,
        issue: {
          code: "RFQ_ALLOCATION_OVERRIDE_NOT_APPLICABLE",
          message: "Excess-allocation approval is only valid above the remaining recommendation",
          statusCode: 400,
          context,
        },
      };
    }
    return {
      ok: true,
      evidence: {
        quantityOverrideReason: reason,
        allocationOverrideReason: null,
        allocationOverrideApprovedBy: null,
        allocationOverrideApprovedAt: null,
        allocationOverrideBaselinePieces: null,
        allocationOverrideExcessPieces: null,
      },
    };
  }

  if (!input.allocationOverrideApproved) {
    return {
      ok: false,
      issue: {
        code: "RFQ_ALLOCATION_OVERRIDE_APPROVAL_REQUIRED",
        message: "Approve the above-recommendation sourcing exception before creating the RFQ",
        statusCode: 400,
        context,
      },
    };
  }

  const approvedBy = input.approvedBy?.trim() || null;
  if (!approvedBy) {
    return {
      ok: false,
      issue: {
        code: "RFQ_ALLOCATION_OVERRIDE_ACTOR_REQUIRED",
        message: "Above-recommendation sourcing requires an authenticated approver",
        statusCode: 403,
        context,
      },
    };
  }

  return {
    ok: true,
    evidence: {
      quantityOverrideReason: reason,
      allocationOverrideReason: reason,
      allocationOverrideApprovedBy: approvedBy,
      allocationOverrideApprovedAt: input.approvedAt,
      allocationOverrideBaselinePieces: input.remainingPieces,
      allocationOverrideExcessPieces: excessPieces,
    },
  };
}
