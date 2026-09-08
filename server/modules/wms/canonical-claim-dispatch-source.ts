import { z } from "zod";
import { WMS_WAREHOUSE_STATUS_VALUES } from "@shared/enums/order-status";
import { canonicalClaimDispatchCommandSchema, canonicalClaimDispatchEvidenceSchema, type CanonicalClaimDispatchEvidence } from "@shared/types/inventory-availability-dispatch";
import type { CanonicalClaimDispatchSourceOwner } from "../inventory-planning/application/inventory-availability-dispatch.port";
import type { CanonicalClaimDispatchSourcePreparationOwner, CanonicalClaimDispatchPreparedSource } from "../inventory-planning/application/inventory-availability-dispatch-source-command.port";
import { canonicalClaimDispatchSourceRequestSchema } from "../inventory-planning/domain/inventory-availability-dispatch-source-command";

const id = z.number().int().positive().max(2_147_483_647);
const bigintId = z.string().regex(/^[1-9][0-9]{0,18}$/);
const orderSchema = z.object({ id, warehouse_id: id.nullable(), warehouse_status: z.enum(WMS_WAREHOUSE_STATUS_VALUES),
  on_hold: z.union([z.literal(0), z.literal(1)]), cancelled: z.boolean() }).strict();
const itemSchema = z.object({ id, order_id: id, product_id: id.nullable(),
  status: z.enum(["pending", "in_progress", "short", "completed", "cancelled"]),
  on_hold: z.boolean(), requires_shipping: z.union([z.literal(0), z.literal(1)]) }).strict();
const headerSchema = z.object({ id, order_id: id.nullable(), status: z.string().nullable(), held: z.boolean(),
  requires_review: z.boolean(), shipment_purpose: z.string(), replaces_shipment_id: id.nullable(), cancelled: z.boolean(), voided: z.boolean() }).strict();
const sourceSchema = z.object({ id, shipment_id: id, order_item_id: id.nullable(), product_variant_id: id.nullable(),
  qty: z.number().int(), from_location_id: id.nullable(), shipment_item_purpose: z.string(),
  replacement_for_order_item_id: id.nullable(), correction_for_shipment_item_id: id.nullable(), provider_membership_state: z.string() }).strict();
const physicalIdentitySchema = z.object({ id: bigintId, physical_shipment_id: bigintId }).strict();
const physicalHeaderSchema = z.object({ id: bigintId, status: z.string() }).strict();
const physicalItemSchema = physicalIdentitySchema.extend({ legacy_wms_shipment_item_id: id.nullable(),
  wms_order_item_id: id.nullable(), product_variant_id: id.nullable(), quantity_shipped: z.number().int(),
  shipment_item_purpose: z.string(), replacement_for_order_item_id: id.nullable(),
  correction_for_physical_shipment_item_id: bigintId.nullable(), package_allocation_entry_id: bigintId.nullable() }).strict();

export class WmsCanonicalClaimDispatchSourceError extends Error {
  readonly classification = "permanent";
  constructor(readonly code: string, message: string, readonly context: Readonly<Record<string, unknown>> = {}) {
    super(message); this.name = "WmsCanonicalClaimDispatchSourceError";
  }
}
function requireFact(condition: boolean, code: string, message: string): asserts condition {
  if (!condition) throw new WmsCanonicalClaimDispatchSourceError(code, message);
}
function parse<T>(schema: z.ZodType<T>, value: unknown, entity: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new WmsCanonicalClaimDispatchSourceError("WMS_DISPATCH_EVIDENCE_INVALID",
    "WMS dispatch evidence is missing or violates its strict contract", { entity, issues: result.error.issues });
  return result.data;
}

/**
 * Locked WMS source facts, not caller-supplied dispatch authority. The caller owns
 * one SERIALIZABLE read-write transaction and must retry it in full on 40001.
 * Lock order: order -> item -> source header -> source item -> physical header
 * -> physical item. No inventory, warehouse, catalog or OMS owner tables are read.
 * Persisted source bin identity is mandatory; historical last-pick/primary-bin
 * fallbacks from the legacy ship path are deliberately not authorizing evidence.
 */
export class WmsCanonicalClaimDispatchSourceOwner implements CanonicalClaimDispatchSourceOwner, CanonicalClaimDispatchSourcePreparationOwner {
  async lockDispatchSource(input: Parameters<CanonicalClaimDispatchSourceOwner["lockDispatchSource"]>[0]):
    Promise<Omit<CanonicalClaimDispatchEvidence["source"], "dispatchedQuantity">> {
    const command = parse(canonicalClaimDispatchCommandSchema, input.command, "command");
    const { orderId, orderItemId, outboundShipmentId, sourceShipmentItemId, productVariantId, quantity, actor, reason } = command;
    const source = await this.lockSourceForPreparation({ client: input.client,
      request: { orderId, orderItemId, outboundShipmentId, sourceShipmentItemId, productVariantId, quantity, actor, reason } });
    requireFact(source.warehouseId === command.warehouseId && source.warehouseLocationId === command.warehouseLocationId,
      "WMS_DISPATCH_IDENTITY_MISMATCH", "Order warehouse or persisted source bin differs from the exact command");
    requireFact(source.physicalShipmentId === command.physicalShipmentId && source.physicalShipmentItemId === command.physicalShipmentItemId,
      "WMS_DISPATCH_PHYSICAL_CONFLICT", "Existing physical shipment identity must be bound to the command");
    return { ...source, warehouseLocationId: command.warehouseLocationId };
  }

  async lockSourceForPreparation(input: Parameters<CanonicalClaimDispatchSourcePreparationOwner["lockSourceForPreparation"]>[0]):
    Promise<CanonicalClaimDispatchPreparedSource> {
    const command = parse(canonicalClaimDispatchSourceRequestSchema, input.request, "sourceRequest");
    const { client } = input;
    const settings = await client.query("SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only");
    requireFact(settings.rows.length === 1 && settings.rows[0].isolation === "serializable" && settings.rows[0].read_only === "off",
      "WMS_DISPATCH_TRANSACTION_REQUIRED", "Dispatch source locks require the caller's SERIALIZABLE read-write transaction");

    const order = parse(orderSchema, (await client.query(`SELECT id, warehouse_id, warehouse_status, on_hold,
      (cancelled_at IS NOT NULL) AS cancelled FROM wms.orders WHERE id=$1 FOR UPDATE`, [command.orderId])).rows[0], "order");
    requireFact(order.id === command.orderId && order.warehouse_id !== null,
      "WMS_DISPATCH_IDENTITY_MISMATCH", "Order must belong to an explicit dispatch warehouse");
    requireFact(!order.cancelled && order.warehouse_status !== "cancelled", "WMS_DISPATCH_CANCELLED", "Cancelled orders cannot dispatch picked custody");
    requireFact(order.on_hold === 0 && order.warehouse_status !== "on_hold", "WMS_DISPATCH_HELD", "The order is held");
    requireFact(!["exception", "awaiting_3pl"].includes(order.warehouse_status), "WMS_DISPATCH_NOT_AUTHORIZED", "Order requires review or external custody authority");

    const item = parse(itemSchema, (await client.query(`SELECT id, order_id, product_id, status, on_hold, requires_shipping
      FROM wms.order_items WHERE id=$1 FOR UPDATE`, [command.orderItemId])).rows[0], "orderItem");
    // Legacy product_id may be a base-product ID, a variant ID, or null:
    // claim.repository.loadOrder resolves SKU and accepts both identities, while
    // persistCanonicalWmsPickProgress never rewrites this historical hint. The
    // exact variant is the source variant plus the caller's locked claim target.
    requireFact(item.id === command.orderItemId && item.order_id === command.orderId,
      "WMS_DISPATCH_IDENTITY_MISMATCH", "Order item does not belong to this exact order");
    requireFact(item.status !== "cancelled", "WMS_DISPATCH_CANCELLED", "Cancelled order items cannot dispatch picked custody");
    requireFact(!item.on_hold, "WMS_DISPATCH_HELD", "The order item is held");
    requireFact(item.requires_shipping === 1, "WMS_DISPATCH_NOT_AUTHORIZED", "Nonshipping items cannot dispatch physical custody");

    const header = parse(headerSchema, (await client.query(`SELECT id, order_id, status, held, requires_review, shipment_purpose,
      replaces_shipment_id, (cancelled_at IS NOT NULL) AS cancelled, (voided_at IS NOT NULL) AS voided
      FROM wms.outbound_shipments WHERE id=$1 FOR UPDATE`, [command.outboundShipmentId])).rows[0], "shipment");
    requireFact(header.id === command.outboundShipmentId && header.order_id === command.orderId,
      "WMS_DISPATCH_IDENTITY_MISMATCH", "Source shipment belongs to another order");
    requireFact(!header.held, "WMS_DISPATCH_HELD", "The source shipment is held");
    requireFact(header.status === "shipped" && !header.cancelled && !header.voided && !header.requires_review
      && header.shipment_purpose === "customer_fulfillment" && header.replaces_shipment_id === null,
    "WMS_DISPATCH_NOT_AUTHORIZED", "Dispatch requires an unheld, shipped customer source without cancellation, replacement or review");

    const source = parse(sourceSchema, (await client.query(`SELECT id, shipment_id, order_item_id, product_variant_id, qty,
      from_location_id, shipment_item_purpose, replacement_for_order_item_id, correction_for_shipment_item_id, provider_membership_state
      FROM wms.outbound_shipment_items WHERE id=$1 FOR UPDATE`, [command.sourceShipmentItemId])).rows[0], "sourceItem");
    requireFact(source.id === command.sourceShipmentItemId && source.shipment_id === command.outboundShipmentId
      && source.order_item_id === command.orderItemId && source.product_variant_id === command.productVariantId,
    "WMS_DISPATCH_IDENTITY_MISMATCH", "Source identity differs from the exact command");
    requireFact(source.qty > 0 && String(source.qty) === command.quantity, "WMS_DISPATCH_QUANTITY_MISMATCH", "Dispatch must consume the complete positive source row quantity");
    requireFact(source.shipment_item_purpose === "customer_fulfillment" && source.replacement_for_order_item_id === null
      && source.correction_for_shipment_item_id === null && source.provider_membership_state === "authoritative",
    "WMS_DISPATCH_NOT_AUTHORIZED", "Source requires authoritative ordinary customer membership without replacement or correction");

    // Source FOR UPDATE blocks insertion of a new legacy-linked physical item via
    // its FK key-share lock. Existing physical facts are bound exactly, not guessed
    // from tracking or the physical header's compatibility request pointer.
    const physicalRows = await client.query(`SELECT id::text AS id, physical_shipment_id::text AS physical_shipment_id
      FROM wms.physical_shipment_items WHERE legacy_wms_shipment_item_id=$1 ORDER BY id LIMIT 2`, [source.id]);
    requireFact(physicalRows.rows.length <= 1, "WMS_DISPATCH_PHYSICAL_CONFLICT", "Multiple physical items claim the same source");
    let physicalQuantity: string | null = null;
    let physicalShipmentId: string | null = null;
    let physicalShipmentItemId: string | null = null;
    if (physicalRows.rows.length !== 0) {
      const identity = parse(physicalIdentitySchema, physicalRows.rows[0], "physicalIdentity");
      physicalShipmentId = identity.physical_shipment_id;
      physicalShipmentItemId = identity.id;
      const physicalHeader = parse(physicalHeaderSchema, (await client.query(`SELECT id::text AS id, status
        FROM wms.physical_shipments WHERE id=$1::bigint FOR UPDATE`, [identity.physical_shipment_id])).rows[0], "physicalShipment");
      const physicalItem = parse(physicalItemSchema, (await client.query(`SELECT id::text AS id, physical_shipment_id::text AS physical_shipment_id,
        legacy_wms_shipment_item_id, wms_order_item_id, product_variant_id, quantity_shipped, shipment_item_purpose,
        replacement_for_order_item_id, correction_for_physical_shipment_item_id::text AS correction_for_physical_shipment_item_id,
        package_allocation_entry_id::text AS package_allocation_entry_id
        FROM wms.physical_shipment_items WHERE id=$1::bigint FOR UPDATE`, [identity.id])).rows[0], "physicalItem");
      requireFact(physicalHeader.id === identity.physical_shipment_id && physicalHeader.status === "shipped"
        && physicalItem.id === identity.id && physicalItem.physical_shipment_id === physicalHeader.id
        && physicalItem.legacy_wms_shipment_item_id === source.id && physicalItem.wms_order_item_id === item.id
        && physicalItem.product_variant_id === command.productVariantId && physicalItem.quantity_shipped === source.qty
        && physicalItem.shipment_item_purpose === "customer_fulfillment" && physicalItem.replacement_for_order_item_id === null
        && physicalItem.correction_for_physical_shipment_item_id === null && physicalItem.package_allocation_entry_id === null,
      "WMS_DISPATCH_PHYSICAL_CONFLICT", "Physical source lineage, purpose, state or quantity does not match the complete outbound source");
      // Migration182's adjustment validator takes this same physical item lock.
      // Read after locking; do not use the positive-only effective view, which
      // hides fully corrected items. Correction reconciliation is a separate path.
      const adjustments = await client.query("SELECT physical_shipment_item_id FROM wms.physical_shipment_item_quantity_adjustments WHERE physical_shipment_item_id=$1::bigint LIMIT 1", [identity.id]);
      requireFact(adjustments.rows.length === 0, "WMS_DISPATCH_PHYSICAL_CORRECTION", "Corrected physical evidence needs explicit inventory reconciliation before dispatch");
      physicalQuantity = String(physicalItem.quantity_shipped);
    }
    const preparedSourceSchema = canonicalClaimDispatchEvidenceSchema.shape.source.innerType().extend({ warehouseLocationId: id.nullable() })
      .superRefine((value, context) => {
        if ((value.physicalShipmentId === null) !== (value.physicalShipmentItemId === null)
          || (value.physicalShipmentItemId === null) !== (value.physicalShipmentItemQuantity === null)) {
          context.addIssue({ code: "custom", message: "Prepared physical source must carry an exact identity and quantity pair" });
        }
      });
    const result = parse(preparedSourceSchema, {
      orderId: order.id, orderItemId: item.id, warehouseId: order.warehouse_id, warehouseLocationId: source.from_location_id,
      productVariantId: source.product_variant_id, outboundShipmentId: header.id, sourceShipmentItemId: source.id,
      physicalShipmentId, physicalShipmentItemId,
      physicalShipmentItemQuantity: physicalQuantity, quantity: String(source.qty), dispatchedQuantity: "0",
      readiness: "authorized", orderStatus: order.warehouse_status,
    }, "sourceResult");
    const { dispatchedQuantity: _journalOwned, ...facts } = result;
    return facts;
  }

  async bindSourceLocation(input: Parameters<CanonicalClaimDispatchSourcePreparationOwner["bindSourceLocation"]>[0]): Promise<void> {
    const request = parse(canonicalClaimDispatchSourceRequestSchema, input.request, "sourceRequest");
    const locationId = parse(id, input.warehouseLocationId, "warehouseLocationId");
    const settings = (await input.client.query("SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only")).rows;
    requireFact(settings.length === 1 && settings[0].isolation === "serializable" && settings[0].read_only === "off",
      "WMS_DISPATCH_TRANSACTION_REQUIRED", "Source bin assignment requires the caller's SERIALIZABLE read-write transaction");
    // The preparation method already owns the order/header/source FOR UPDATE
    // locks. This conditional write can only fill missing evidence, never revise
    // a historical source bin. Its caller must roll back on any later failure.
    const result = await input.client.query(`UPDATE wms.outbound_shipment_items SET from_location_id=$1
      WHERE id=$2 AND shipment_id=$3 AND order_item_id=$4 AND product_variant_id=$5
        AND qty=$6 AND from_location_id IS NULL`,
    [locationId, request.sourceShipmentItemId, request.outboundShipmentId, request.orderItemId, request.productVariantId, request.quantity]);
    requireFact(result.rowCount === 1, "WMS_DISPATCH_SOURCE_BIN_CHANGED", "Exact source bin could not be assigned from proved claim custody");
  }
}
