import { z } from "zod";
import { SHIPMENT_HEADER_MODES } from "./shipment-header-input";
import { shipmentPurchaseOrderReferencesSchema } from "./shipment-purchase-orders";
import { landedCostHealthSchema } from "./landed-cost-health";

export const SHIPMENT_LIST_STATUSES = ["draft", "booked", "in_transit", "at_port", "customs_clearance", "delivered", "costing", "closed", "cancelled"] as const;
export const SHIPMENT_COST_FILTERS = ["all", "any", "critical", "warning", "allocation", "needs_finalize", "ready_to_push", "stale_provisional"] as const;
export type ShipmentCostFilter = typeof SHIPMENT_COST_FILTERS[number];
export const SHIPMENT_LIST_PAGE_SIZE = 50;
export const SHIPMENT_SCAN_PAGE_SIZE = 100;
const count = z.number().int().nonnegative().safe();
const id = z.number().int().positive().max(2_147_483_647);
const queryInteger = (schema: z.ZodNumber) => z.preprocess(value => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value, schema);
const statuses = z.union([z.enum(SHIPMENT_LIST_STATUSES), z.array(z.enum(SHIPMENT_LIST_STATUSES)).min(1), z.literal("active"), z.literal("all")]);
export const shipmentWorkListQuerySchema = z.object({
  status: z.preprocess(value => typeof value === "string" && value.includes(",") ? value.split(",") : value, statuses).optional(),
  mode: z.enum(SHIPMENT_HEADER_MODES).optional(),
  search: z.string().trim().max(200).optional(),
  warehouseId: queryInteger(id).optional(),
  costFilter: z.enum(SHIPMENT_COST_FILTERS).default("all"),
  limit: queryInteger(z.number().int().min(1).max(250)).default(SHIPMENT_LIST_PAGE_SIZE),
  offset: queryInteger(z.number().int().nonnegative().max(2_147_483_647)).default(0),
}).strict();
export type ShipmentWorkListQuery = z.infer<typeof shipmentWorkListQuerySchema>;

const text = z.string().nullable();
const date = z.string().datetime({ offset: true }).nullable();
const cents = z.number().int().safe().nullable();
// Preserve the existing header response, including fields used by PO selectors.
// Optional legacy fields are still type-checked whenever they are present.
export const shipmentWorkListItemSchema = z.object({
  id, shipmentNumber: z.string().min(1), status: z.string().min(1), mode: text,
  carrierName: text, forwarderName: text, containerNumber: text,
  originPort: text, destinationPort: text, originCountry: text, destinationCountry: text,
  warehouseId: id.nullable(), eta: date, estimatedTotalCostCents: cents, actualTotalCostCents: cents,
  notes: text, createdAt: z.string().datetime({ offset: true }),
  purchaseOrders: shipmentPurchaseOrderReferencesSchema,
  shipperName: text.optional(), bookingReference: text.optional(), sealNumber: text.optional(),
  containerSize: text.optional(), containerCapacityCbm: text.optional(), bolNumber: text.optional(),
  houseBol: text.optional(), trackingNumber: text.optional(), totalWeightKg: text.optional(),
  totalVolumeCbm: text.optional(), totalGrossVolumeCbm: text.optional(), grossWeightKg: text.optional(),
  physicalMeasurementIssue: z.object({ code: z.string(), message: z.string() }).strict().nullable().optional(),
  palletCount: count.nullable().optional(), totalPieces: count.nullable().optional(), totalCartons: count.nullable().optional(),
  allocationMethodDefault: text.optional(), internalNotes: text.optional(), createdBy: text.optional(), closedBy: text.optional(),
  shipDate: date.optional(), etd: date.optional(), actualArrival: date.optional(), customsClearedDate: date.optional(),
  deliveredDate: date.optional(), closedAt: date.optional(), updatedAt: date.optional(), lineCount: count.optional(),
}).strict();
export const shipmentWorkListPageSchema = z.object({
  shipments: z.array(shipmentWorkListItemSchema), total: count,
  limit: z.number().int().min(1).max(250), offset: count, hasMore: z.boolean(),
  costHealthItems: landedCostHealthSchema.innerType().shape.items,
}).strict().superRefine((page, context) => {
  if (page.shipments.length > page.limit || page.shipments.length !== Math.min(page.limit, Math.max(0, page.total - page.offset))
    || page.hasMore !== (page.offset + page.shipments.length < page.total)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Shipment page does not match its total and continuation." });
  }
  const ids = new Set(page.shipments.map(shipment => shipment.id));
  if (ids.size !== page.shipments.length || page.costHealthItems.some(item => !ids.has(item.shipmentId))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Shipment page contains duplicate or unrelated evidence." });
  }
});
export type ShipmentWorkListPage = z.infer<typeof shipmentWorkListPageSchema>;
export type ShipmentWorkListItem = z.infer<typeof shipmentWorkListItemSchema>;

/** Membership consumes the same issues as the health overview; it never re-derives posting. */
export function matchesShipmentCostFilter(issues: z.infer<typeof landedCostHealthSchema>["items"], filter: ShipmentCostFilter): boolean {
  switch (filter) {
    case "all": return true;
    case "any": return issues.length > 0;
    case "critical": case "warning": return issues.some(issue => issue.severity === filter);
    case "allocation": return issues.some(issue => ["allocation_blocked", "allocation_warning"].includes(issue.type));
    case "needs_finalize": return issues.some(issue => issue.type === "pending_finalization");
    case "ready_to_push": return issues.some(issue => issue.type === "finalized_not_pushed");
    case "stale_provisional": return issues.some(issue => issue.type === "stale_provisional_lots");
  }
}
