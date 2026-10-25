import { z } from "zod";
const id = z.number().int().positive().max(2_147_483_647);
const integer = z.preprocess(value => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value, z.number().int().safe());
export const purchaseOrderWorkListQuerySchema = z.object({
  vendorId: integer.pipe(id).optional(),
  search: z.string().trim().max(200).default(""),
  purpose: z.enum(["invoice-create", "invoice-link", "shipment-lines"]),
  excludeIds: z.string().max(11_000).transform(value => value.split(",")).pipe(z.array(z.string().regex(/^\d+$/).transform(Number).pipe(id)).max(1000)).refine(ids => new Set(ids).size === ids.length, "Duplicate excluded PO IDs").optional(),
  limit: integer.pipe(z.number().min(1).max(100)).default(20),
  offset: integer.pipe(z.number().min(0).max(2_147_483_647)).default(0),
}).strict().refine(query => query.purpose === "shipment-lines" || query.vendorId !== undefined, {
  path: ["vendorId"], message: "A vendor is required for invoice purchase-order selection",
});
export const purchaseOrderWorkListPageSchema = z.object({
  items: z.array(z.object({ id, vendorId: id, poNumber: z.string(), status: z.string(), totalCents: z.number().int().safe() }).strict()),
  total: z.number().int().nonnegative().safe(), limit: z.number().int().min(1).max(100), offset: z.number().int().nonnegative().safe(), nextOffset: z.number().int().nonnegative().safe().nullable(),
}).strict().refine(page => page.items.length === Math.min(page.limit, Math.max(0, page.total - page.offset)) && page.nextOffset === (page.offset + page.items.length < page.total ? page.offset + page.items.length : null), "Inconsistent PO page");
export type PurchaseOrderWorkListQuery = z.infer<typeof purchaseOrderWorkListQuerySchema>;
export type PurchaseOrderWorkListPage = z.infer<typeof purchaseOrderWorkListPageSchema>;
