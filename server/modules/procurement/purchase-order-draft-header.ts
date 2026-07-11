import { z } from "zod";

import { poPriorityEnum, poTypeEnum } from "@shared/schema/procurement.schema";

const nullableText = (maxLength: number) => z.string().max(maxLength).nullable().optional();
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const nullableDate = z
  .preprocess(
    (value) => value === "" ? null : value,
    z.union([z.date(), z.string().trim().min(1), z.null()]),
  )
  .transform((value, ctx): Date | null => {
    if (value === null) return null;
    if (
      typeof value === "string" &&
      !ISO_DATE.test(value) &&
      !ISO_TIMESTAMP_WITH_ZONE.test(value)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "cancelDate must be an ISO date or timestamp with timezone",
      });
      return z.NEVER;
    }
    const parsed = value instanceof Date
      ? new Date(value.getTime())
      : new Date(ISO_DATE.test(value) ? `${value}T00:00:00.000Z` : value);
    if (Number.isNaN(parsed.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "cancelDate must be a valid date" });
      return z.NEVER;
    }
    return parsed;
  })
  .optional();

export const purchaseOrderDraftHeaderPatchSchema = z
  .object({
    warehouseId: z.number().int().positive().nullable().optional(),
    shipToAddress: nullableText(10_000),
    shipFromAddress: nullableText(10_000),
    poType: z.enum(poTypeEnum).optional(),
    priority: z.enum(poPriorityEnum).optional(),
    cancelDate: nullableDate,
    paymentTermsDays: z.number().int().min(0).max(3_650).nullable().optional(),
    paymentTermsType: nullableText(20),
    shippingMethod: nullableText(50),
    shippingAccountNumber: nullableText(50),
    freightTerms: nullableText(30),
    referenceNumber: nullableText(100),
    vendorContactName: nullableText(100),
    vendorContactEmail: z.string().email().max(255).nullable().optional(),
    vendorNotes: nullableText(20_000),
    internalNotes: nullableText(20_000),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (Object.keys(input).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one draft header field is required",
      });
    }
  });

export type PurchaseOrderDraftHeaderPatch = z.infer<typeof purchaseOrderDraftHeaderPatchSchema>;

const auditFieldNames = {
  warehouseId: "warehouse_id",
  shipToAddress: "ship_to_address",
  shipFromAddress: "ship_from_address",
  poType: "po_type",
  priority: "priority",
  cancelDate: "cancel_date",
  paymentTermsDays: "payment_terms_days",
  paymentTermsType: "payment_terms_type",
  shippingMethod: "shipping_method",
  shippingAccountNumber: "shipping_account_number",
  freightTerms: "freight_terms",
  referenceNumber: "reference_number",
  vendorContactName: "vendor_contact_name",
  vendorContactEmail: "vendor_contact_email",
  vendorNotes: "vendor_notes",
  internalNotes: "internal_notes",
} as const satisfies Record<keyof PurchaseOrderDraftHeaderPatch, string>;

type DraftHeaderField = keyof typeof auditFieldNames;

export type PurchaseOrderDraftHeaderChange = {
  patch: PurchaseOrderDraftHeaderPatch;
  changedFields: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
};

function valuesEqual(current: unknown, requested: unknown): boolean {
  if (current instanceof Date || requested instanceof Date) {
    const currentTime = current instanceof Date ? current.getTime() : new Date(String(current)).getTime();
    const requestedTime = requested instanceof Date ? requested.getTime() : new Date(String(requested)).getTime();
    return currentTime === requestedTime;
  }
  return current === requested;
}

function auditValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value ?? null;
}

export function buildPurchaseOrderDraftHeaderChange(
  current: Record<string, unknown>,
  requested: PurchaseOrderDraftHeaderPatch,
): PurchaseOrderDraftHeaderChange {
  const patch: Record<string, unknown> = {};
  const changedFields: string[] = [];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};

  for (const field of Object.keys(auditFieldNames) as DraftHeaderField[]) {
    const requestedValue = requested[field];
    if (requestedValue === undefined || valuesEqual(current[field], requestedValue)) continue;

    patch[field] = requestedValue;
    const auditField = auditFieldNames[field];
    changedFields.push(auditField);
    before[auditField] = auditValue(current[field]);
    after[auditField] = auditValue(requestedValue);
  }

  return {
    patch: patch as PurchaseOrderDraftHeaderPatch,
    changedFields,
    before,
    after,
  };
}
