import { eq } from "drizzle-orm";
import { z } from "zod";
import { purchaseOrders, purchaseOrderLines, poEvents, poStatusHistory, vendors } from "@shared/schema";
import { insertPurchaseOrderSchema, poTypeEnum, poPriorityEnum } from "@shared/schema/procurement.schema";
import type { PurchaseOrderEntryCommand } from "@shared/procurement/purchase-order-entry-command";
import { PurchasingError, type CreatePurchaseOrderWithLinesInput, type UpdateDraftPurchaseOrderWithLinesInput } from "./purchasing.service";
import { mapPurchaseOrderWithLinesInput, parseNullableDateInput } from "./purchase-order-entry-input";
import { assertNoLegacyPurchaseOrderEntry, type PurchaseOrderEntryTransaction } from "./purchase-order-entry.repository";
import { assertPurchaseOrderEntryAuthority, PurchaseOrderEntryError } from "./domain/purchase-order-entry";
import { readCommandAuthorityActor } from "../identity";
import { millisecondTransactionTimestamp } from "./purchase-order-lifecycle-version";

type Po = typeof purchaseOrders.$inferSelect;
type Lines = (typeof purchaseOrderLines.$inferSelect & { clientId?: string })[];
interface EntryPorts {
  now(): Date;
  generatePoNumber(): Promise<string>;
  create(tx: PurchaseOrderEntryTransaction, input: CreatePurchaseOrderWithLinesInput, actorId: string): Promise<Po>;
  save(tx: PurchaseOrderEntryTransaction, id: number, input: UpdateDraftPurchaseOrderWithLinesInput, actorId: string): Promise<{ po: Po; lines: Lines }>;
  duplicate(tx: PurchaseOrderEntryTransaction, id: number, overrides: { vendorId?: number; expectedDeliveryDate?: Date | null }, actorId: string): Promise<Po>;
  prepare(tx: PurchaseOrderEntryTransaction, id: number, actorId: string, solo: boolean): Promise<{ po: Po; status: string; pendingApproval: boolean }>;
}

async function snapshot(tx: PurchaseOrderEntryTransaction, id: number) {
  const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)).limit(1).for("update");
  if (!po) throw new PurchasingError("Purchase order not found", 404);
  const lines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, id)).orderBy(purchaseOrderLines.lineNumber).for("update");
  return { po, lines };
}

const emptyHeader = insertPurchaseOrderSchema.pick({
  vendorId: true, warehouseId: true, poType: true, priority: true, expectedDeliveryDate: true,
  shipToAddress: true, shippingMethod: true, incoterms: true, freightTerms: true,
  vendorNotes: true, internalNotes: true, source: true,
}).extend({
  vendorId: z.number().int().positive().max(2_147_483_647),
  warehouseId: z.number().int().positive().max(2_147_483_647).nullish(),
  poType: z.enum(poTypeEnum),
  priority: z.enum(poPriorityEnum),
  expectedDeliveryDate: z.date().nullish(),
  source: z.enum(["manual", "auto_draft", "reorder"]),
});

/** Empty legacy creation now shares the command transaction, instead of the
 * old storage helper's independent insert. Existing source metadata is retained. */
async function createEmpty(tx: PurchaseOrderEntryTransaction, body: Record<string, unknown>, actorId: string, ports: EntryPorts): Promise<Po> {
  const mapped = mapPurchaseOrderWithLinesInput(body, false);
  const parsed = emptyHeader.safeParse({ ...mapped, poType: mapped.poType ?? "standard", priority: mapped.priority ?? "normal",
    shipToAddress: body.ship_to_address ?? body.shipToAddress, shippingMethod: body.shipping_method ?? body.shippingMethod,
    freightTerms: body.freight_terms ?? body.freightTerms, source: body.source ?? "manual" });
  if (!parsed.success) throw new PurchasingError("Review the empty purchase order header", 400, { code: "PURCHASE_ORDER_ENTRY_INPUT_INVALID" });
  const [vendor] = await tx.select().from(vendors).where(eq(vendors.id, parsed.data.vendorId)).limit(1).for("share");
  if (!vendor) throw new PurchasingError("Vendor not found", 404);
  if (vendor.active !== 1) throw new PurchasingError("Vendor is inactive", 409, { code: "PO_VENDOR_INACTIVE" });
  if ((vendor.currency ?? "USD").trim().toUpperCase() !== "USD") throw new PurchasingError("Purchase orders currently support USD only", 400, { code: "PO_CURRENCY_UNSUPPORTED" });
  const poNumber = await ports.generatePoNumber();
  const [po] = await tx.insert(purchaseOrders).values({ ...parsed.data, poNumber, status: "draft", currency: "USD",
    paymentTermsDays: vendor.paymentTermsDays, paymentTermsType: vendor.paymentTermsType, shipFromAddress: vendor.shipFromAddress,
    createdBy: actorId, updatedBy: actorId, createdAt: millisecondTransactionTimestamp(), updatedAt: millisecondTransactionTimestamp(),
  }).returning();
  await tx.insert(poStatusHistory).values({ purchaseOrderId: po.id, fromStatus: null, toStatus: "draft", changedBy: actorId, notes: "PO created" });
  return po;
}

export async function executePurchaseOrderEntry(tx: PurchaseOrderEntryTransaction, command: PurchaseOrderEntryCommand,
  actorId: string, key: string, ports: EntryPorts): Promise<Record<string, unknown>> {
  assertPurchaseOrderEntryAuthority(await readCommandAuthorityActor(tx, actorId), command.action);
  await assertNoLegacyPurchaseOrderEntry(tx, key);
  const recordedAt = ports.now();
  if (!Number.isFinite(recordedAt.getTime())) throw new PurchaseOrderEntryError("PURCHASE_ORDER_ENTRY_CLOCK_INVALID", "Purchase order entry requires a valid clock", 500);
  const before = command.targetId === null ? null : await snapshot(tx, command.targetId);
  let po: Po;
  let body: Record<string, unknown> = {};
  const clientIds = new Map<number, string>();
  const payload = command.payload;
  for (const flag of ["prepare_for_supplier", "advance_to_sent"] as const) {
    if (payload[flag] !== undefined && typeof payload[flag] !== "boolean") throw new PurchasingError(`${flag} must be a boolean`, 400);
  }
  if (command.action === "create") {
    if (payload.lines !== undefined && !Array.isArray(payload.lines)) throw new PurchasingError("lines must be an array", 400);
    po = Array.isArray(payload.lines) && payload.lines.length > 0
      ? await ports.create(tx, mapPurchaseOrderWithLinesInput(payload, false), actorId)
      : await createEmpty(tx, payload, actorId, ports);
    if (!Array.isArray(payload.lines) || payload.lines.length === 0) body = { ...po };
  } else if (command.action === "save-draft") {
    const expectedUpdatedAt = parseNullableDateInput(payload.expected_updated_at ?? payload.expectedUpdatedAt, "expectedUpdatedAt");
    if (!expectedUpdatedAt) throw new PurchasingError("expected_updated_at is required", 400, { code: "PO_DRAFT_EXPECTED_VERSION_REQUIRED" });
    const updated = await ports.save(tx, command.targetId, { ...mapPurchaseOrderWithLinesInput(payload, true), expectedUpdatedAt }, actorId);
    po = updated.po;
    for (const line of updated.lines) if (line.clientId !== undefined) clientIds.set(line.id, line.clientId);
  } else if (command.action === "duplicate") {
    const overrides: { vendorId?: number; expectedDeliveryDate?: Date | null } = {};
    if (payload.vendor_id !== undefined || payload.vendorId !== undefined) {
      const vendorId = Number(payload.vendor_id ?? payload.vendorId);
      if (!Number.isSafeInteger(vendorId) || vendorId <= 0 || vendorId > 2_147_483_647) throw new PurchasingError("vendor_id must be a positive integer", 400);
      overrides.vendorId = vendorId;
    }
    if (payload.expected_delivery_date !== undefined || payload.expectedDeliveryDate !== undefined) {
      overrides.expectedDeliveryDate = parseNullableDateInput(payload.expected_delivery_date ?? payload.expectedDeliveryDate, "expectedDeliveryDate");
    }
    po = await ports.duplicate(tx, command.targetId, overrides, actorId);
    body = { id: po.id, po_number: po.poNumber };
  } else {
    if (Object.keys(payload).length > 0) throw new PurchasingError("Supplier preparation does not accept additional fields", 400);
    const prepared = await ports.prepare(tx, command.targetId, actorId, command.action === "prepare");
    po = prepared.po;
    body = command.action === "prepare" ? { ...po } : {
      status: prepared.status, pdf: null, pending_approval: prepared.pendingApproval, dispatch_recorded: false,
      sendError: "Prepared for supplier review. No PDF was sent; review the document and record an external send separately.",
    };
  }
  if ((command.action === "create" || command.action === "save-draft")
    && (payload.prepare_for_supplier === true || payload.advance_to_sent === true)) {
    try {
      // Existing semantics preserve a saved draft when supplier preparation is
      // rejected. A savepoint rolls back preparation before recording that
      // explicit partial outcome in the outer command transaction.
      const prepared = await ports.prepare(tx, po.id, actorId, false);
      po = prepared.po;
      body = { ...body, status: prepared.status, pdf: null, pending_approval: prepared.pendingApproval, dispatch_recorded: false,
        ...(payload.advance_to_sent === true ? { sendError: "PO saved for review. No supplier dispatch was recorded; review the document and record an external send separately." } : {}) };
    } catch (error) {
      if (!(error instanceof PurchasingError) || error.statusCode < 400 || error.statusCode >= 500) throw error;
      body = { ...body, status: po.status, dispatch_recorded: false, sendError: error.message };
    }
  }
  const after = await snapshot(tx, po.id);
  const activeLines = after.lines.filter(line => line.status !== "cancelled").map(line => ({
    ...line, ...(clientIds.has(line.id) ? { clientId: clientIds.get(line.id) } : {}),
  }));
  await tx.insert(poEvents).values({ poId: po.id, eventType: `entry_${command.action.replaceAll("-", "_")}`,
    actorType: "user", actorId, createdAt: recordedAt,
    payloadJson: { command_key: key, action: command.action, before, after },
  });
  return { ...body, po: after.po, lines: activeLines };
}
