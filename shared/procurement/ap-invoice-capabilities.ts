import { z } from "zod";

export const apInvoiceEditCapabilitySchema = z.object({
  allowed: z.boolean(),
  requiredPermission: z.literal("purchasing:edit"),
  code: z.enum(["AP_INVOICE_EDITABLE", "AP_INVOICE_IMMUTABLE", "AP_INVOICE_FINANCIAL_HISTORY", "AP_INVOICE_SOURCE_REVIEW_REQUIRED"]),
  reason: z.string().min(1),
}).refine(value => value.allowed === (value.code === "AP_INVOICE_EDITABLE"), {
  message: "Invoice edit availability must agree with its decision code",
});

export type ApInvoiceEditCapability = z.infer<typeof apInvoiceEditCapabilitySchema>;
