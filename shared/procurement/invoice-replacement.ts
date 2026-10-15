import { z } from "zod";

const id = z.number().int().positive().max(2_147_483_647);
export const invoiceReplacementInputSchema = z.object({
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string().trim().min(1).max(2_000),
}).strict();
export const invoiceReplacementCapabilitySchema = z.object({
  allowed: z.boolean(), code: z.string().nullable(), message: z.string().min(1),
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/), successorInvoiceId: id.nullable(),
}).strict().refine(value => value.allowed === (value.code === null) && (!value.allowed || value.successorInvoiceId === null), {
  message: "Replacement availability must agree with the decision and successor identity",
});
export const invoiceReplacementHistorySchema = z.array(z.object({
  id, invoiceNumber: z.string(), status: z.string(), replacesInvoiceId: id.nullable(),
  createdAt: z.union([z.date(), z.string().datetime()]).nullable(),
}).strict());
export const invoiceReplacementResultSchema = z.object({
  invoiceId: id, replacesInvoiceId: id, invoiceNumber: z.string().min(1),
  status: z.literal("received"), freightCostIds: z.array(id).min(1),
}).strict().refine(value => value.invoiceId !== value.replacesInvoiceId && new Set(value.freightCostIds).size === value.freightCostIds.length, {
  message: "Replacement must create a distinct invoice with unique charge assignments",
});
export type InvoiceReplacementCapability = z.infer<typeof invoiceReplacementCapabilitySchema>;
export type InvoiceReplacementHistory = z.infer<typeof invoiceReplacementHistorySchema>;
export type ReplacementInvoiceInput = z.infer<typeof invoiceReplacementInputSchema>;
export type ReplacementInvoiceResult = z.infer<typeof invoiceReplacementResultSchema>;
