import { z } from "zod";

const id = z.number().int().positive().max(2_147_483_647);
const cents = z.number().int().safe();
const queryInteger = z.preprocess(value => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value, z.number().int().safe());
const statusList = z.string().min(1).max(250).transform(value => value.split(",")).pipe(z.array(z.string().trim().min(1).max(20)).min(1).max(20)).optional();
const queryBase = {
  vendorId: queryInteger.pipe(id).optional(),
  search: z.string().trim().max(200).default(""),
  status: statusList,
  limit: queryInteger.pipe(z.number().min(1).max(100)).default(50),
  offset: queryInteger.pipe(z.number().min(0).max(2_147_483_647)).default(0),
};
export const invoiceWorkListQuerySchema = z.object({
  ...queryBase,
  overdue: z.enum(["true", "false"]).transform(value => value === "true").optional(),
}).strict();
export const paymentWorkListQuerySchema = z.object({
  ...queryBase,
  paymentMethod: z.string().trim().min(1).max(20).optional(),
}).strict();
export type InvoiceWorkListQuery = z.infer<typeof invoiceWorkListQuerySchema>;
export type PaymentWorkListQuery = z.infer<typeof paymentWorkListQuerySchema>;

export const invoiceWorkListItemSchema = z.object({
  id, vendorId: id, invoiceNumber: z.string(), ourReference: z.string().nullable(),
  vendorName: z.string().nullable(), vendorCode: z.string().nullable(), status: z.string(),
  invoiceDate: z.string().datetime().nullable(), dueDate: z.string().datetime().nullable(),
  invoicedAmountCents: cents, paidAmountCents: cents, balanceCents: cents,
  inboundShipmentId: id.nullable(), currency: z.string(), poNumbers: z.array(z.string()),
}).strict();
export const paymentWorkListItemSchema = z.object({
  id, vendorId: id, paymentNumber: z.string(), vendorName: z.string().nullable(), vendorCode: z.string().nullable(),
  paymentDate: z.string().datetime(), paymentMethod: z.string(), referenceNumber: z.string().nullable(),
  checkNumber: z.string().nullable(), totalAmountCents: cents, currency: z.string(), status: z.string(),
}).strict();
const pageFields = { total: z.number().int().nonnegative().safe(), limit: z.number().int().min(1).max(100), offset: z.number().int().nonnegative().safe(), nextOffset: z.number().int().nonnegative().safe().nullable() };
function consistentPage(page: { items: unknown[]; total: number; limit: number; offset: number; nextOffset: number | null }): boolean {
  return page.items.length === Math.min(page.limit, Math.max(0, page.total - page.offset))
    && page.nextOffset === (page.offset + page.items.length < page.total ? page.offset + page.items.length : null);
}
export const invoiceWorkListPageSchema = z.object({ items: z.array(invoiceWorkListItemSchema), ...pageFields }).strict().refine(consistentPage, "Inconsistent invoice page");
export const paymentWorkListPageSchema = z.object({ items: z.array(paymentWorkListItemSchema), ...pageFields }).strict().refine(consistentPage, "Inconsistent payment page");
export type InvoiceWorkListPage = z.infer<typeof invoiceWorkListPageSchema>;
export type PaymentWorkListPage = z.infer<typeof paymentWorkListPageSchema>;
