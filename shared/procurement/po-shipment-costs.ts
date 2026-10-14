import { z } from "zod";
import { costIssueSchema, type CostIssue } from "./cost-source-contracts";
import { poShipmentCostSummarySchema } from "./po-shipment-cost-summary";

const id = z.number().int().positive().max(2_147_483_647);
const applicationId = z.number().int().positive().safe();
const cents = z.number().int().safe();
export const shipmentCostLineStatusSchema = z.enum([
  "applied",
  "review_required",
  "pending",
]);

export const poShipmentCostsSchema = z
  .object({
    summary: poShipmentCostSummarySchema,
    supplier: z.object({ freightCents: cents, dutyCents: cents }).strict(),
    totals: z
      .object({
        freightCents: cents.nullable(),
        dutyCents: cents.nullable(),
        combinedCostCents: cents.nullable(),
      })
      .strict(),
    lines: z.array(
      z
        .object({
          lineId: id,
          shipmentId: id,
          shipmentNumber: z.string().nullable(),
          shipmentStatus: z.string(),
          sku: z.string().nullable(),
          allocatedCents: cents,
          status: shipmentCostLineStatusSchema,
          applicationId: applicationId.nullable(),
          recordedAt: z.string().datetime({ offset: true }).nullable(),
          issues: z.array(costIssueSchema),
        })
        .strict(),
    ),
  })
  .strict();

export type PoShipmentCosts = z.infer<typeof poShipmentCostsSchema>;

/** The existing application owner returns additional audit fields as well. */
export const shipmentCostPushResultSchema = z
  .object({
    status: z.enum(["applied", "review_required"]),
    updated: z.number().int().nonnegative().safe(),
    total: z.number().int().nonnegative().safe(),
    skipped: z.array(
      z.object({
        applicationId: applicationId.nullable(),
        reason: costIssueSchema.shape.code,
        message: costIssueSchema.shape.message,
      }),
    ),
  })
  .passthrough();

export function shipmentCostReviewGuidance(issues: readonly CostIssue[]): {
  explanation: string | null;
  nextStep: string;
} {
  const codes = new Set(issues.map((issue) => issue.code));
  const previousRoundingCodes = new Set([
    "COST_UNIFORM_LOT_RESIDUAL_REVIEW",
    "COST_TRANSFORM_RESIDUAL_REVIEW",
    "COST_GRAPH_INCOMPLETE",
  ]);
  if (
    codes.has("COST_UNIFORM_LOT_RESIDUAL_REVIEW") &&
    [...codes].every((code) => previousRoundingCodes.has(code))
  ) {
    return {
      explanation:
        "The earlier cost update could not distribute the charge exactly across the received units.",
      nextStep:
        "Retry the inventory cost update. The current calculation will check the exact amounts and lot history again.",
    };
  }
  if ([...codes].some((code) => code.startsWith("LANDED_ALLOCATION"))) {
    return {
      explanation: null,
      nextStep:
        "Open the shipment's Allocation tab, correct the allocation and finalize it before retrying.",
    };
  }
  if (
    [...codes].some(
      (code) =>
        code.startsWith("LANDED_INVOICE") || code === "LANDED_SOURCE_MISSING",
    )
  ) {
    return {
      explanation: null,
      nextStep:
        "Check the shipment charges and their supplier invoice, then retry the inventory cost update.",
    };
  }
  if (
    [...codes].some(
      (code) =>
        code.includes("HISTORICAL") ||
        code.includes("GRAPH") ||
        code.includes("LINEAGE") ||
        code.includes("CONTRIBUTION"),
    )
  ) {
    return {
      explanation: null,
      nextStep:
        "Review the recorded receipt, transfer or conversion history for the affected lots before retrying.",
    };
  }
  if (codes.has("COST_MANUAL_OVERRIDE_REVIEW")) {
    return {
      explanation: null,
      nextStep:
        "Have a purchasing approver review the existing manual cost correction before retrying.",
    };
  }
  if (codes.has("COST_UPDATE_NOT_RECORDED")) {
    return {
      explanation: null,
      nextStep:
        "Confirm the shipment charges and finalize their allocation, then update inventory costs.",
    };
  }
  if (codes.has("LANDED_CHARGES_UNCONFIRMED")) {
    return {
      explanation: null,
      nextStep:
        "Confirm the shipment charge amounts against the supplier invoice before updating inventory costs.",
    };
  }
  if (codes.has("COST_UPDATE_OUTDATED")) {
    return {
      explanation: null,
      nextStep:
        "Retry the inventory cost update to check the current confirmed charges and allocation.",
    };
  }
  return {
    explanation: null,
    nextStep:
      "Open the shipment to review the recorded reason. Retry the cost update after correcting its source.",
  };
}
