import { z } from "zod";
import { costIssueSchema, type CostIssue } from "./cost-source-contracts";
import { poShipmentCostSummarySchema } from "./po-shipment-cost-summary";
import { shipmentCostExceptionSchema } from "./shipment-cost-exception";

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
          exceptionReview: shipmentCostExceptionSchema.nullable().optional(),
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
  if (codes.has("COST_UNRESOLVED_QUANTITY_RETAINED")) {
    return {
      explanation: null,
      nextStep: "Review the named lot's stock movements and order cost records. The unexplained amount is retained separately; retrying will not resolve it or change stock counts.",
    };
  }
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
        "Select Update shipment costs. It recalculates the charge split and updates stock and sold-order costs.",
    };
  }
  if ([...codes].some((code) => code.startsWith("LANDED_ALLOCATION"))) {
    return {
      explanation: codes.has("LANDED_ALLOCATION_MISSING")
        ? "These shipment lines do not have a saved charge split yet."
        : "The saved charge split needs updating before it can be used for inventory costs.",
      nextStep:
        "Select Update shipment costs to recalculate the charge split and apply it. If a source value is missing, correct the named shipment line or charge first.",
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
        "Check the shipment charges and their supplier invoice, then select Update shipment costs.",
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
        "Check that the shipment charges are correct, then select Update shipment costs.",
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
        "Select Update shipment costs to apply the current confirmed charges and charge split.",
    };
  }
  return {
    explanation: null,
    nextStep:
      "Check the reason shown above. Select Update shipment costs after correcting the affected record.",
  };
}
