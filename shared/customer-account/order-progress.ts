import { z } from "zod";

export const CUSTOMER_ORDER_PROGRESS_VERSION = "v2" as const;
const status = z
  .object({
    code: z
      .string()
      .regex(/^[a-z_]+$/)
      .max(50),
    label: z.string().min(1).max(100),
  })
  .strict();
export const customerDeliveryStatusSchema = status.extend({
  code: z.enum([
    "awaiting_carrier",
    "shipped",
    "in_transit",
    "partially_delivered",
    "delivered",
    "delivery_issue",
    "delivery_attempted",
    "ready_for_pickup",
    "unknown",
  ]),
});
export type CustomerDeliveryStatus = z.infer<
  typeof customerDeliveryStatusSchema
>;
export const customerReturnProgressStatusSchema = status.extend({
  code: z.enum([
    "started",
    "label_ready",
    "in_transit",
    "delivery_issue",
    "delivered",
    "partially_received",
    "received",
    "under_review",
    "complete",
    "cancelled",
    "needs_attention",
    "not_required",
  ]),
});
export type CustomerReturnProgressStatus = z.infer<
  typeof customerReturnProgressStatusSchema
>;
export const customerReturnRefundStatusSchema = status.extend({
  code: z.enum([
    "not_started",
    "processing",
    "completed",
    "partially_completed",
    "failed",
    "not_required",
  ]),
});
export type CustomerReturnRefundStatus = z.infer<
  typeof customerReturnRefundStatusSchema
>;
export const customerDeliveryPackageSchema = z
  .object({
    key: z.string().min(1).max(200),
    trackingNumber: z.string().min(1).max(200).nullable(),
    status: customerDeliveryStatusSchema,
  })
  .strict();
export const customerReturnProgressSchema = z
  .object({
    key: z.string().min(1).max(100),
    reference: z.string().min(1).max(100),
    status: customerReturnProgressStatusSchema,
    refund: customerReturnRefundStatusSchema,
    quantity: z.number().int().nonnegative().safe(),
    receivedQuantity: z.number().int().nonnegative().safe(),
    parcels: z.array(customerDeliveryPackageSchema).max(200),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.parcels.map((parcel) => parcel.key)).size !==
      value.parcels.length
    )
      context.addIssue({
        code: "custom",
        path: ["parcels"],
        message: "Duplicate return parcel identities.",
      });
    if (value.receivedQuantity > value.quantity)
      context.addIssue({
        code: "custom",
        path: ["receivedQuantity"],
        message: "Received units exceed the authorized return.",
      });
  });
export const customerOrderProgressSchema = z
  .object({
    unavailable: z
      .array(z.enum(["delivery", "returns", "refunds"]))
      .max(3)
      .default([]),
    delivery: customerDeliveryStatusSchema.nullable(),
    packages: z.array(customerDeliveryPackageSchema).max(200),
    returns: z.array(customerReturnProgressSchema).max(200),
    refunds: z
      .array(
        z
          .object({
            key: z.string().min(1).max(100),
            reference: z.string().min(1).max(100),
            status: customerReturnRefundStatusSchema,
          })
          .strict(),
      )
      .max(200)
      .default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.packages.map((p) => p.key)).size !==
        value.packages.length ||
      new Set(value.returns.map((r) => r.key)).size !== value.returns.length ||
      new Set(value.refunds.map((r) => r.key)).size !== value.refunds.length ||
      new Set(value.unavailable).size !== value.unavailable.length
    )
      context.addIssue({
        code: "custom",
        message: "Duplicate progress identities are not allowed.",
      });
    if (
      (value.unavailable.includes("delivery") &&
        (value.delivery !== null || value.packages.length > 0)) ||
      (value.unavailable.includes("returns") && value.returns.length > 0) ||
      (value.unavailable.includes("refunds") && value.refunds.length > 0)
    )
      context.addIssue({
        code: "custom",
        message: "Unavailable tracks cannot claim current progress.",
      });
    if (
      value.delivery?.code === "delivered" &&
      (!value.packages.length ||
        value.packages.some((p) => p.status.code !== "delivered"))
    )
      context.addIssue({
        code: "custom",
        path: ["delivery"],
        message: "Delivered requires evidence for every outbound package.",
      });
  });
export type CustomerOrderProgress = z.infer<typeof customerOrderProgressSchema>;
export type CustomerReturnProgress = z.infer<
  typeof customerReturnProgressSchema
>;
