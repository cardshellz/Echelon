import { z } from "zod";
import type {
  CustomerDeliveryStatus,
  CustomerReturnProgressStatus,
  CustomerReturnRefundStatus,
} from "@shared/customer-account/order-progress";

export const customerReturnCaseProgressFactsSchema = z
  .object({
    caseStatus: z.enum(["open", "closed", "cancelled", "exception"]),
    approvalStatus: z.enum(["pending", "approved", "rejected"]),
    logisticsStatus: z.enum([
      "not_required",
      "awaiting_return",
      "label_ready",
      "in_transit",
      "delivered",
      "partially_received",
      "received",
    ]),
    inspectionStatus: z.enum([
      "not_required",
      "pending",
      "in_progress",
      "approved",
      "rejected",
    ]),
    customerRefundStatus: z.enum([
      "pending",
      "completed",
      "failed",
      "not_required",
    ]),
    refundAttemptStatus: z.enum(["pending", "completed", "failed"]).nullable(),
    quantity: z.number().int().nonnegative().safe(),
    receivedQuantity: z.number().int().nonnegative().safe(),
    labelReady: z.boolean(),
    labelInvalid: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.receivedQuantity > value.quantity)
      context.addIssue({
        code: "custom",
        message: "Receipt exceeds expected return units.",
      });
  });
export type CustomerReturnCaseProgressFacts = z.infer<
  typeof customerReturnCaseProgressFactsSchema
>;

export function presentCustomerReturnRefund(
  raw: CustomerReturnCaseProgressFacts,
): CustomerReturnRefundStatus {
  const facts = customerReturnCaseProgressFactsSchema.parse(raw);
  if (facts.customerRefundStatus === "completed")
    return { code: "completed", label: "Refund issued" };
  if (facts.refundAttemptStatus === "pending")
    return { code: "processing", label: "Refund processing" };
  if (
    facts.customerRefundStatus === "failed" ||
    facts.refundAttemptStatus === "failed"
  )
    return { code: "failed", label: "Refund needs attention" };
  if (facts.customerRefundStatus === "not_required")
    return { code: "not_required", label: "No refund required" };
  // 'pending' is initialized when intake opens a case. It is not evidence that
  // money was sent or that a refund command has even been submitted.
  return { code: "not_started", label: "Refund not started" };
}
export function presentCustomerReturn(
  raw: CustomerReturnCaseProgressFacts,
  tracking: readonly CustomerDeliveryStatus[] = [],
): CustomerReturnProgressStatus {
  const facts = customerReturnCaseProgressFactsSchema.parse(raw);
  if (facts.caseStatus === "cancelled")
    return { code: "cancelled", label: "Cancelled" };
  if (
    facts.caseStatus === "exception" ||
    facts.approvalStatus === "rejected" ||
    facts.inspectionStatus === "rejected"
  )
    return { code: "needs_attention", label: "Needs attention" };
  const allReceived =
    facts.quantity > 0 && facts.receivedQuantity === facts.quantity;
  if (facts.caseStatus === "closed") {
    return allReceived || facts.logisticsStatus === "not_required"
      ? { code: "complete", label: "Complete" }
      : { code: "needs_attention", label: "Needs attention" };
  }
  if (allReceived || facts.logisticsStatus === "received") {
    if (!allReceived)
      return { code: "needs_attention", label: "Needs attention" };
    return facts.inspectionStatus === "in_progress"
      ? { code: "under_review", label: "Under review" }
      : { code: "received", label: "Received" };
  }
  if (
    tracking.some((p) =>
      ["delivery_issue", "delivery_attempted"].includes(p.code),
    )
  )
    return {
      code: "delivery_issue",
      label:
        facts.receivedQuantity > 0
          ? "Partially received — delivery issue"
          : "Delivery issue",
    };
  if (
    facts.receivedQuantity > 0 ||
    facts.logisticsStatus === "partially_received"
  )
    return { code: "partially_received", label: "Partially received" };
  if (facts.logisticsStatus === "not_required")
    return { code: "not_required", label: "No shipment required" };

  if (
    (tracking.length > 0 && tracking.every((p) => p.code === "delivered")) ||
    facts.logisticsStatus === "delivered"
  )
    return { code: "delivered", label: "Delivered — awaiting receipt" };
  if (
    tracking.some((p) =>
      ["shipped", "in_transit", "delivered", "ready_for_pickup"].includes(
        p.code,
      ),
    ) ||
    facts.logisticsStatus === "in_transit"
  )
    return { code: "in_transit", label: "In transit" };
  if (facts.labelInvalid)
    return { code: "needs_attention", label: "Label needs attention" };
  return facts.labelReady || facts.logisticsStatus === "label_ready"
    ? { code: "label_ready", label: "Label ready — awaiting drop-off" }
    : { code: "started", label: "Started" };
}

/** One accepted authorization may span several warehouse cases. Present the
 * remaining physical work together without counting partitions as new returns. */
export function aggregateCustomerReturnCases(
  cases: readonly CustomerReturnCaseProgressFacts[],
  tracking: readonly CustomerDeliveryStatus[],
): {
  status: CustomerReturnProgressStatus;
  refund: CustomerReturnRefundStatus;
  quantity: number;
  receivedQuantity: number;
} {
  if (!cases.length)
    throw new Error("Return progress requires its original cases.");
  const checked = cases.map((facts) =>
    customerReturnCaseProgressFactsSchema.parse(facts),
  );
  const active = checked.filter((facts) => facts.caseStatus !== "cancelled");
  const relevant = active.length ? active : checked;
  const quantity = z
    .number()
    .int()
    .nonnegative()
    .safe()
    .parse(relevant.reduce((sum, facts) => sum + facts.quantity, 0));
  const receivedQuantity = z
    .number()
    .int()
    .nonnegative()
    .safe()
    .parse(relevant.reduce((sum, facts) => sum + facts.receivedQuantity, 0));
  const every = (
    key: "logisticsStatus" | "inspectionStatus" | "caseStatus",
    value: string,
  ) => relevant.every((facts) => facts[key] === value);
  const any = (
    key: "caseStatus" | "approvalStatus" | "inspectionStatus",
    value: string,
  ) => relevant.some((facts) => facts[key] === value);
  const merged: CustomerReturnCaseProgressFacts = {
    caseStatus: !active.length
      ? "cancelled"
      : any("caseStatus", "exception") ||
          relevant.some(
            (facts) => presentCustomerReturn(facts).code === "needs_attention",
          )
        ? "exception"
        : every("caseStatus", "closed")
          ? "closed"
          : "open",
    approvalStatus: any("approvalStatus", "rejected")
      ? "rejected"
      : any("approvalStatus", "pending")
        ? "pending"
        : "approved",
    logisticsStatus: every("logisticsStatus", "not_required")
      ? "not_required"
      : receivedQuantity === quantity && quantity > 0
        ? "received"
        : receivedQuantity > 0
          ? "partially_received"
          : relevant.every((f) =>
                ["delivered", "not_required"].includes(f.logisticsStatus),
              )
            ? "delivered"
            : relevant.some((f) => f.logisticsStatus === "in_transit")
              ? "in_transit"
              : "awaiting_return",
    inspectionStatus: any("inspectionStatus", "rejected")
      ? "rejected"
      : any("inspectionStatus", "in_progress")
        ? "in_progress"
        : every("inspectionStatus", "not_required")
          ? "not_required"
          : every("inspectionStatus", "approved")
            ? "approved"
            : "pending",
    customerRefundStatus: "pending",
    refundAttemptStatus: null,
    quantity,
    receivedQuantity,
    labelReady: relevant.every((facts) => facts.labelReady),
    labelInvalid: relevant.some((facts) => facts.labelInvalid),
  };
  const refunds = checked.map(presentCustomerReturnRefund);
  const refund: CustomerReturnRefundStatus = refunds.some(
    (r) => r.code === "failed",
  )
    ? { code: "failed", label: "Refund needs attention" }
    : refunds.some((r) => r.code === "processing")
      ? { code: "processing", label: "Refund processing" }
      : refunds.every(
            (r) => r.code === "completed" || r.code === "not_required",
          ) && refunds.some((r) => r.code === "completed")
        ? { code: "completed", label: "Refund issued" }
        : refunds.some((r) => r.code === "completed")
          ? { code: "partially_completed", label: "Refund partly issued" }
          : refunds.every((r) => r.code === "not_required")
            ? { code: "not_required", label: "No refund required" }
            : { code: "not_started", label: "Refund not started" };
  return {
    status: presentCustomerReturn(merged, tracking),
    refund,
    quantity,
    receivedQuantity,
  };
}
