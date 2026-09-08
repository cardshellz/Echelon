import { z } from "zod";
import type { RecordInventoryShipmentInput, RecordReplacementInventoryShipmentInput } from "../../inventory/application/inventory.use-cases";
import type { OperationalShipmentRequest, OperationalShipmentResult } from "../../inventory/domain/operational-shipment-dispatch";
import type { CanonicalClaimDispatchSourceRequest } from "./inventory-availability-dispatch-source-command.port";

const id = z.number().int().positive().max(2_147_483_647);
const shipmentInputSchema = z.object({
  productVariantId: id,
  // A legacy reader's bin is a hint only. Canonical dispatch resolves immutable
  // picked custody and may bind an absent source bin through the WMS owner.
  warehouseLocationId: id.nullable(),
  qty: id,
  orderId: id,
  orderItemId: id.optional(),
  shipmentId: z.string().regex(/^[1-9][0-9]*$/).refine(
    (value) => Number.isSafeInteger(Number(value)) && Number(value) <= 2_147_483_647,
  ),
  shipmentItemId: id,
  userId: z.string().trim().min(1).max(100).optional(),
  deductFromOnHandOnly: z.boolean().optional(),
  releaseReservation: z.boolean().optional(),
}).strict();

export type InventoryShipmentRuntimeInput = z.infer<typeof shipmentInputSchema>;

export type InventoryShipmentRuntimeContext =
  | { authority: "legacy"; recordLegacy(input: RecordInventoryShipmentInput): Promise<void>;
      recordLegacyReplacement?(input: RecordReplacementInventoryShipmentInput): Promise<{ warehouseLocationId: number; alreadyRecorded: boolean }> }
  | { authority: "canonical"; dispatchSource(request: CanonicalClaimDispatchSourceRequest): Promise<void>;
      dispatchOperationalSource?(request: OperationalShipmentRequest): Promise<OperationalShipmentResult> };

export interface InventoryShipmentRuntimeExecutor {
  execute<T>(work: (context: InventoryShipmentRuntimeContext) => Promise<T>): Promise<T>;
}

export class InventoryShipmentRuntimeError extends Error {
  constructor(readonly code: string, message: string, readonly context: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "InventoryShipmentRuntimeError";
  }
}

/** The channel supplies source identity, never the inventory authority or bin. */
export class AuthorityAwareInventoryShipmentRecorder {
  constructor(private readonly executor: InventoryShipmentRuntimeExecutor) {}

  async recordReplacementShipmentFromAvailableInventory(raw: RecordReplacementInventoryShipmentInput):
    Promise<{ warehouseLocationId: number; alreadyRecorded: boolean; preserveSourceLocation?: true }> {
    const input = z.object({
      productVariantId: id, qty: id, warehouseId: id.nullable(), orderId: id,
      orderItemId: id.nullable().optional(), shipmentId: id, shipmentItemId: id,
      userId: z.string().trim().min(1).max(100).optional(),
    }).strict().parse(raw);
    return this.executor.execute(async (context) => {
      if (context.authority === "legacy") {
        if (!context.recordLegacyReplacement) throw new InventoryShipmentRuntimeError(
          "LEGACY_REPLACEMENT_OWNER_UNAVAILABLE", "Legacy replacement owner is not connected.");
        return context.recordLegacyReplacement(input);
      }
      if (!context.dispatchOperationalSource) throw new InventoryShipmentRuntimeError(
        "OPERATIONAL_SHIPMENT_OWNER_UNAVAILABLE", "Canonical operational shipment owner is not connected.");
      return context.dispatchOperationalSource({
        orderId: input.orderId, outboundShipmentId: input.shipmentId, sourceShipmentItemId: input.shipmentItemId,
        productVariantId: input.productVariantId, quantity: input.qty, actor: input.userId ?? "system:inventory-shipment",
      });
    });
  }

  async recordShipment(rawInput: InventoryShipmentRuntimeInput): Promise<void> {
    const parsed = shipmentInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new InventoryShipmentRuntimeError("INVENTORY_SHIPMENT_INPUT_INVALID",
        "Shipment inventory input does not satisfy the source-identity contract.", { issues: parsed.error.issues });
    }
    const input = parsed.data;
    return this.executor.execute(async (context) => {
      if (context.authority === "legacy") {
        if (input.warehouseLocationId === null) {
          throw new InventoryShipmentRuntimeError("LEGACY_SHIPMENT_SOURCE_LOCATION_REQUIRED",
            "Legacy shipment recording requires a valid source location.", { sourceShipmentItemId: input.shipmentItemId });
        }
        return context.recordLegacy({ ...input, warehouseLocationId: input.warehouseLocationId });
      }
      if (input.orderItemId === undefined || input.releaseReservation === false) {
        if (!context.dispatchOperationalSource) throw new InventoryShipmentRuntimeError(
          "CANONICAL_SHIPMENT_PURPOSE_UNSUPPORTED", "Canonical non-customer shipment owner is not connected.",
          { sourceShipmentItemId: input.shipmentItemId });
        await context.dispatchOperationalSource({
          orderId: input.orderId, outboundShipmentId: Number(input.shipmentId),
          sourceShipmentItemId: input.shipmentItemId, productVariantId: input.productVariantId,
          quantity: input.qty, actor: input.userId ?? "system:inventory-shipment",
        });
        return;
      }
      return context.dispatchSource({
        orderId: input.orderId,
        orderItemId: input.orderItemId,
        outboundShipmentId: Number(input.shipmentId),
        sourceShipmentItemId: input.shipmentItemId,
        productVariantId: input.productVariantId,
        quantity: String(input.qty),
        actor: input.userId ?? "system:inventory-shipment",
        reason: "Provider-confirmed customer shipment inventory posting",
      });
    });
  }
}
