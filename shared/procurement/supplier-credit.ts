import { z } from "zod";
import { paymentCalendarDateSchema } from "./ap-payment-contract";
export const supplierCreditIdSchema = z.number().int().positive().max(2_147_483_647);
const id = supplierCreditIdSchema;
const cents = z.number().int().nonnegative().safe();
const positiveCents = cents.positive();
const version = z.string().regex(/^[a-f0-9]{64}$/);
const reason = z.string().trim().min(3).max(2000);
export const supplierCreditIssueSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1)
}).strict();
export const supplierCreditCostStateSchema = z.enum(["pending", "posted", "review_required", "not_applicable"]);
export const supplierCreditDispositionSchema = z.discriminatedUnion("kind", [z.object({
  kind: z.literal("price_reduction"),
  component: z.enum(["product", "packaging", "landed"])
}).strict(), z.object({
  kind: z.literal("quarantine_return"),
  returnDispositionId: id,
  quantity: id,
  evidenceReference: z.string().trim().min(1).max(200)
}).strict()]);
export const supplierCreditSourceLineInputSchema = z.object({
  invoiceLineId: id,
  amountCents: positiveCents,
  disposition: supplierCreditDispositionSchema
}).strict();
export type SourceLineInput = z.infer<typeof supplierCreditSourceLineInputSchema>;
export function supplierCreditLineSourceKey(line: SourceLineInput): string {
  return line.disposition.kind === "price_reduction" ? `price_reduction:${line.disposition.component}` : `quarantine_return:${line.disposition.returnDispositionId}`;
}
export const supplierCreditCreateInputSchema = z.object({
  sourceInvoiceId: id,
  expectedSourceVersion: version,
  replacesCreditId: id.optional(),
  supplierReference: z.string().trim().min(1).max(100),
  creditCalendarDate: paymentCalendarDateSchema,
  reason,
  lines: z.array(supplierCreditSourceLineInputSchema).min(1).max(100)
}).strict().superRefine((value, context) => {
  if (new Set(value.lines.map(line => `${line.invoiceLineId}:${supplierCreditLineSourceKey(line)}`)).size !== value.lines.length) context.addIssue({
    code: "custom",
    path: ["lines"],
    message: "Choose each invoice component or return source only once per credit."
  });
  if (value.lines.every(line => Number.isSafeInteger(line.amountCents)) && value.lines.reduce((sum, line) => sum + BigInt(line.amountCents), BigInt(0)) > BigInt(Number.MAX_SAFE_INTEGER)) context.addIssue({
    code: "custom",
    path: ["lines"],
    message: "Credit total exceeds the supported exact amount."
  });
});
export type SupplierCreditCreateInput = z.infer<typeof supplierCreditCreateInputSchema>;
export const supplierCreditReviewInputSchema = z.object({
  expectedVersion: version,
  reason
}).strict();
export const supplierCreditApplyInputSchema = supplierCreditReviewInputSchema.extend({
  allocations: z.array(z.object({
    vendorInvoiceId: id,
    appliedAmountCents: positiveCents
  }).strict()).min(1).max(100)
}).superRefine((value, context) => {
  if (new Set(value.allocations.map(row => row.vendorInvoiceId)).size !== value.allocations.length) context.addIssue({
    code: "custom",
    path: ["allocations"],
    message: "Choose each target invoice only once per application."
  });
  if (value.allocations.every(row => Number.isSafeInteger(row.appliedAmountCents)) && value.allocations.reduce((sum, row) => sum + BigInt(row.appliedAmountCents), BigInt(0)) > BigInt(Number.MAX_SAFE_INTEGER)) context.addIssue({
    code: "custom",
    path: ["allocations"],
    message: "Application total exceeds the supported exact amount."
  });
});
export type SupplierCreditApplyInput = z.infer<typeof supplierCreditApplyInputSchema>;
export const supplierCreditCapabilitySchema = z.object({
  allowed: z.boolean(),
  code: z.string(),
  reason: z.string()
}).strict();
const timestamp = z.string().datetime();
export const supplierCreditApplicationSchema = z.object({
  id,
  vendorInvoiceId: id,
  invoiceNumber: z.string(),
  appliedAmountCents: positiveCents,
  actorId: z.string(),
  recordedAt: timestamp,
  reason: z.string(),
  reversal: z.object({
    id,
    actorId: z.string(),
    recordedAt: timestamp,
    reason: z.string()
  }).strict().nullable(),
  canReverse: supplierCreditCapabilitySchema
}).strict();
export const supplierCreditLineSchema = supplierCreditSourceLineInputSchema.extend({
  id,
  label: z.string(),
  sourceEvidence: z.record(z.string(), z.unknown()),
  costState: supplierCreditCostStateSchema,
  costIssues: z.array(supplierCreditIssueSchema)
}).strict();
export const supplierCreditDetailSchema = z.object({
  id,
  sourceInvoiceId: id,
  sourceInvoiceNumber: z.string(),
  vendorId: id,
  vendorName: z.string(),
  currency: z.literal("USD"),
  supplierReference: z.string(),
  creditCalendarDate: paymentCalendarDateSchema,
  reason: z.string(),
  status: z.enum(["draft", "approved", "voided"]),
  version,
  replacesCreditId: id.nullable(),
  replacedByCreditId: id.nullable(),
  totalAmountCents: positiveCents,
  appliedAmountCents: cents.nullable(),
  unappliedAmountCents: cents.nullable(),
  balanceState: z.enum(["draft", "available", "fully_applied", "voided", "review_required"]),
  balanceIssues: z.array(supplierCreditIssueSchema),
  costStatus: supplierCreditCostStateSchema,
  costIssues: z.array(supplierCreditIssueSchema),
  createdBy: z.string(),
  createdAt: timestamp,
  approvedBy: z.string().nullable(),
  approvedAt: timestamp.nullable(),
  voidedBy: z.string().nullable(),
  voidedAt: timestamp.nullable(),
  voidReason: z.string().nullable(),
  lines: z.array(supplierCreditLineSchema),
  applications: z.array(supplierCreditApplicationSchema),
  capabilities: z.object({
    approve: supplierCreditCapabilitySchema,
    apply: supplierCreditCapabilitySchema,
    void: supplierCreditCapabilitySchema,
    replace: supplierCreditCapabilitySchema
  }).strict()
}).strict().superRefine((value, context) => {
  if (value.appliedAmountCents !== null && value.unappliedAmountCents !== null && value.status === "approved" && [value.appliedAmountCents, value.unappliedAmountCents, value.totalAmountCents].every(Number.isSafeInteger) && BigInt(value.appliedAmountCents) + BigInt(value.unappliedAmountCents) !== BigInt(value.totalAmountCents)) context.addIssue({
    code: "custom",
    message: "Credit balance does not conserve the document amount."
  });
});
export type SupplierCreditDetail = z.infer<typeof supplierCreditDetailSchema>;
export const supplierCreditListQuerySchema = z.object({
  vendorId: z.coerce.number().int().positive().max(2_147_483_647).optional(),
  sourceInvoiceId: z.coerce.number().int().positive().max(2_147_483_647).optional(),
  invoiceId: z.coerce.number().int().positive().max(2_147_483_647).optional(),
  status: z.enum(["draft", "approved", "voided"]).optional(),
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(2_147_483_647).default(0)
}).strict();
export const supplierCreditListSchema = z.object({
  items: z.array(supplierCreditDetailSchema),
  total: cents,
  limit: z.number().int().positive(),
  offset: cents,
  nextOffset: cents.nullable()
}).strict();
export type SupplierCreditList = z.infer<typeof supplierCreditListSchema>;
export const supplierCreditOptionsSchema = z.object({
  sourceInvoiceId: id,
  invoiceNumber: z.string(),
  vendorId: id,
  vendorName: z.string(),
  currency: z.literal("USD"),
  sourceVersion: version,
  canCreate: supplierCreditCapabilitySchema,
  lines: z.array(z.object({
    invoiceLineId: id,
    label: z.string(),
    lineAmountCents: cents,
    creditedAmountCents: cents,
    availableAmountCents: cents,
    components: z.array(z.enum(["product", "packaging", "landed"])),
    returnDispositions: z.array(z.object({
      returnDispositionId: id,
      quantityAvailable: id,
      unitLabel: z.string(),
      evidenceReference: z.string(),
      label: z.string()
    }).strict()),
    issues: z.array(supplierCreditIssueSchema)
  }).strict())
}).strict();
export type SupplierCreditOptions = z.infer<typeof supplierCreditOptionsSchema>;
export const supplierCreditCommandSchema = z.enum(["create", "approve", "apply", "reverse", "void"]);
export type SupplierCreditCommand = z.infer<typeof supplierCreditCommandSchema>;
export const supplierCreditCommandResultSchema = z.object({
  command: supplierCreditCommandSchema,
  actorId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  creditId: id,
  request: z.union([supplierCreditCreateInputSchema, supplierCreditApplyInputSchema, supplierCreditReviewInputSchema]),
  applicationIds: z.array(id),
  reversedApplicationId: id.nullable(),
  credit: supplierCreditDetailSchema
}).strict().refine(value => value.credit.id === value.creditId, {
  message: "Credit command identity does not match its result."
});
export type SupplierCreditCommandResult = z.infer<typeof supplierCreditCommandResultSchema>;
