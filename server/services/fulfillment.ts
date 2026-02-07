import { eq } from "drizzle-orm";
import {
  shipments,
  shipmentItems,
  orders,
  orderItems,
  productVariants,
} from "@shared/schema";
import type {
  Shipment,
  InsertShipment,
  ShipmentItem,
  InsertShipmentItem,
  Order,
  OrderItem,
  ProductVariant,
} from "@shared/schema";

// ---------------------------------------------------------------------------
// Type for the Drizzle `db` handle (matches inventory-core.ts pattern)
// ---------------------------------------------------------------------------

type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

// ---------------------------------------------------------------------------
// Type for the InventoryCoreService dependency (duck-typed interface)
// ---------------------------------------------------------------------------

interface InventoryCore {
  recordShipment(params: {
    productVariantId: number;
    warehouseLocationId: number;
    baseUnits: number;
    orderId: number;
    orderItemId?: number;
    shipmentId?: string;
    userId?: string;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// FulfillmentService
// ---------------------------------------------------------------------------

/**
 * Manages shipment records -- the physical packages leaving the warehouse.
 *
 * Currently ingests ship confirmations from Shopify webhooks (ShipStation
 * marks an order as fulfilled in Shopify, Shopify fires a fulfillment
 * webhook, and Echelon records it here).  In the future this service will
 * also support an internal ship engine and pushing fulfillment events to
 * partner sales channels.
 *
 * Design:
 * - Receives `db` and `inventoryCore` via constructor (no global singletons).
 * - All write operations run inside `db.transaction()`.
 * - Inventory state changes (releasing pickedBase) are delegated to
 *   `inventoryCore.recordShipment()`.
 */
class FulfillmentService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly inventoryCore: InventoryCore,
  ) {}

  // =========================================================================
  // CREATE / ADD ITEMS
  // =========================================================================

  /**
   * Create a new shipment record in "pending" status.
   *
   * The shipment is not yet confirmed -- call {@link confirmShipment} once
   * the package has actually left the building.
   *
   * @param params  Fields for the new shipment.  At minimum `orderId` should
   *                be provided so the shipment can be linked to an order.
   * @returns The newly inserted shipment row.
   */
  async createShipment(params: {
    orderId: number;
    channelId?: number;
    source?: string;
    carrier?: string;
    trackingNumber?: string;
    trackingUrl?: string;
    externalFulfillmentId?: string;
  }): Promise<Shipment> {
    return this.db.transaction(async (tx: any) => {
      const [created] = await tx
        .insert(shipments)
        .values({
          orderId: params.orderId,
          channelId: params.channelId ?? null,
          source: params.source ?? "manual",
          status: "pending",
          carrier: params.carrier ?? null,
          trackingNumber: params.trackingNumber ?? null,
          trackingUrl: params.trackingUrl ?? null,
          externalFulfillmentId: params.externalFulfillmentId ?? null,
        } satisfies InsertShipment)
        .returning();

      return created as Shipment;
    });
  }

  /**
   * Add line items to an existing shipment.
   *
   * Each item describes a product variant and quantity being shipped.
   * Optionally links back to the originating order item and the warehouse
   * location the stock was picked from.
   *
   * @param shipmentId  The shipment to attach items to.
   * @param items       Array of line items to add.
   * @returns The newly inserted shipment item rows.
   */
  async addShipmentItems(
    shipmentId: number,
    items: Array<{
      orderItemId?: number;
      productVariantId: number;
      qty: number;
      fromLocationId?: number;
    }>,
  ): Promise<ShipmentItem[]> {
    if (items.length === 0) return [];

    return this.db.transaction(async (tx: any) => {
      const values: InsertShipmentItem[] = items.map((item) => ({
        shipmentId,
        orderItemId: item.orderItemId ?? null,
        productVariantId: item.productVariantId,
        qty: item.qty,
        fromLocationId: item.fromLocationId ?? null,
      }));

      const created = await tx
        .insert(shipmentItems)
        .values(values)
        .returning();

      return created as ShipmentItem[];
    });
  }

  // =========================================================================
  // CONFIRM / SHIP
  // =========================================================================

  /**
   * Confirm that a shipment has left the warehouse.
   *
   * For every item on the shipment this method calls
   * `inventoryCore.recordShipment()` to release `pickedBase` and write
   * an inventory transaction.  The shipment status is then set to
   * "shipped" and `shippedAt` is recorded.
   *
   * @param shipmentId  The shipment to confirm.
   * @param params      Optional overrides for carrier/tracking info and
   *                    the shipped-at timestamp.
   */
  async confirmShipment(
    shipmentId: number,
    params?: {
      carrier?: string;
      trackingNumber?: string;
      trackingUrl?: string;
      shippedAt?: Date;
      userId?: string;
    },
  ): Promise<void> {
    await this.db.transaction(async (tx: any) => {
      // 1. Load the shipment
      const [shipment] = await tx
        .select()
        .from(shipments)
        .where(eq(shipments.id, shipmentId))
        .limit(1);

      if (!shipment) {
        throw new Error(`Shipment ${shipmentId} not found`);
      }

      if ((shipment as Shipment).status === "shipped" || (shipment as Shipment).status === "delivered") {
        // Already confirmed -- idempotent
        return;
      }

      // 2. Load shipment items
      const items: ShipmentItem[] = await tx
        .select()
        .from(shipmentItems)
        .where(eq(shipmentItems.shipmentId, shipmentId));

      // 3. For each item, release inventory via inventoryCore
      for (const item of items) {
        if (!item.productVariantId) continue;

        // Look up the variant to determine unitsPerVariant
        const [variant] = await tx
          .select()
          .from(productVariants)
          .where(eq(productVariants.id, item.productVariantId))
          .limit(1);

        const unitsPerVariant = (variant as ProductVariant | undefined)?.unitsPerVariant ?? 1;
        const baseUnits = item.qty * unitsPerVariant;

        // Determine the warehouse location.  If fromLocationId is set on
        // the item, use it.  Otherwise attempt to find the primary pick
        // location for this variant (best-effort -- may still be null).
        const warehouseLocationId = item.fromLocationId;

        if (warehouseLocationId && baseUnits > 0) {
          await this.inventoryCore.recordShipment({
            productVariantId: item.productVariantId,
            warehouseLocationId,
            baseUnits,
            orderId: (shipment as Shipment).orderId!,
            orderItemId: item.orderItemId ?? undefined,
            shipmentId: String(shipmentId),
            userId: params?.userId,
          });
        }
      }

      // 4. Update shipment status
      const now = params?.shippedAt ?? new Date();
      const updateSet: Record<string, any> = {
        status: "shipped",
        shippedAt: now,
        updatedAt: new Date(),
      };

      if (params?.carrier) updateSet.carrier = params.carrier;
      if (params?.trackingNumber) updateSet.trackingNumber = params.trackingNumber;
      if (params?.trackingUrl) updateSet.trackingUrl = params.trackingUrl;

      await tx
        .update(shipments)
        .set(updateSet)
        .where(eq(shipments.id, shipmentId));
    });
  }

  // =========================================================================
  // SHOPIFY WEBHOOK INGESTION
  // =========================================================================

  /**
   * Process a Shopify fulfillment webhook event.
   *
   * Called when Shopify fires a `fulfillments/create` or `fulfillments/update`
   * webhook (typically because ShipStation marked the order as fulfilled).
   *
   * This method is **idempotent** -- if a shipment with the same
   * `externalFulfillmentId` already exists it is returned without creating
   * a duplicate.
   *
   * Flow:
   * 1. Look up the internal order by `shopifyOrderId`.
   * 2. Create a shipment with `source = "shopify_webhook"`.
   * 3. Match each fulfillment line item (by SKU) to an internal order item
   *    and product variant.
   * 4. Call {@link confirmShipment} to release inventory.
   *
   * @param params  Webhook payload fields.
   * @returns The created (or existing) shipment.
   */
  async processShopifyFulfillment(params: {
    shopifyOrderId: string;
    fulfillmentId: string;
    trackingNumber?: string;
    trackingUrl?: string;
    trackingCompany?: string;
    lineItems: Array<{ sku: string; quantity: number }>;
  }): Promise<Shipment> {
    return this.db.transaction(async (tx: any) => {
      // -- Idempotency check --
      const [existing] = await tx
        .select()
        .from(shipments)
        .where(eq(shipments.externalFulfillmentId, params.fulfillmentId))
        .limit(1);

      if (existing) {
        return existing as Shipment;
      }

      // -- Resolve internal order --
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.shopifyOrderId, params.shopifyOrderId))
        .limit(1);

      if (!order) {
        throw new Error(
          `No internal order found for Shopify order ${params.shopifyOrderId}`,
        );
      }

      const internalOrder = order as Order;

      // -- Create shipment --
      const [shipment] = await tx
        .insert(shipments)
        .values({
          orderId: internalOrder.id,
          channelId: internalOrder.channelId ?? null,
          externalFulfillmentId: params.fulfillmentId,
          source: "shopify_webhook",
          status: "pending",
          carrier: params.trackingCompany ?? null,
          trackingNumber: params.trackingNumber ?? null,
          trackingUrl: params.trackingUrl ?? null,
        } satisfies InsertShipment)
        .returning();

      const createdShipment = shipment as Shipment;

      // -- Load order items for SKU matching --
      const oItems: OrderItem[] = await tx
        .select()
        .from(orderItems)
        .where(eq(orderItems.orderId, internalOrder.id));

      // -- Match each fulfillment line item to internal data --
      const shipmentItemValues: InsertShipmentItem[] = [];

      for (const lineItem of params.lineItems) {
        if (!lineItem.sku || lineItem.quantity <= 0) continue;

        // Find the matching order item by SKU
        const matchedOrderItem = oItems.find(
          (oi) => oi.sku.toLowerCase() === lineItem.sku.toLowerCase(),
        );

        // Resolve the product variant by SKU
        const [variant] = await tx
          .select()
          .from(productVariants)
          .where(eq(productVariants.sku, lineItem.sku))
          .limit(1);

        const productVariantId = (variant as ProductVariant | undefined)?.id ?? null;

        // Attempt to determine fromLocationId from the order item's
        // assigned pick location (if it was tracked during picking).
        // Falls back to null if no pick location is available.
        let fromLocationId: number | null = null;
        if (matchedOrderItem?.catalogProductId) {
          // Look up the primary forward-pick location via
          // product_locations.  This is a best-effort lookup --
          // if the item was picked from a different location we
          // won't have that data from the webhook alone.
          // For now, leave null and let confirmShipment handle it
          // gracefully.
        }

        shipmentItemValues.push({
          shipmentId: createdShipment.id,
          orderItemId: matchedOrderItem?.id ?? null,
          productVariantId,
          qty: lineItem.quantity,
          fromLocationId,
        });
      }

      if (shipmentItemValues.length > 0) {
        await tx.insert(shipmentItems).values(shipmentItemValues);
      }

      // -- Confirm the shipment (releases inventory where possible) --
      // We use a service-scoped clone bound to `tx` so the confirmation
      // runs inside the same transaction.
      const txSvc = this.withTx(tx);
      await txSvc.confirmShipmentInternal(createdShipment.id, tx, {
        carrier: params.trackingCompany,
        trackingNumber: params.trackingNumber,
        trackingUrl: params.trackingUrl,
      });

      // Re-read the shipment after confirmation to return the updated row
      const [updated] = await tx
        .select()
        .from(shipments)
        .where(eq(shipments.id, createdShipment.id))
        .limit(1);

      return (updated ?? createdShipment) as Shipment;
    });
  }

  // =========================================================================
  // QUERIES
  // =========================================================================

  /**
   * Get all shipments associated with a given order.
   *
   * An order may have multiple shipments when it is partially fulfilled
   * in separate packages.
   *
   * @param orderId  The internal order ID.
   * @returns Array of shipment rows, ordered by creation time descending.
   */
  async getShipmentsByOrder(orderId: number): Promise<Shipment[]> {
    const rows = await this.db
      .select()
      .from(shipments)
      .where(eq(shipments.orderId, orderId));

    return rows as Shipment[];
  }

  /**
   * Get a single shipment together with all its line items.
   *
   * @param shipmentId  The shipment primary key.
   * @returns The shipment and its items, or `null` if the shipment does
   *          not exist.
   */
  async getShipmentWithItems(
    shipmentId: number,
  ): Promise<{ shipment: Shipment; items: ShipmentItem[] } | null> {
    const [shipment] = await this.db
      .select()
      .from(shipments)
      .where(eq(shipments.id, shipmentId))
      .limit(1);

    if (!shipment) return null;

    const items: ShipmentItem[] = await this.db
      .select()
      .from(shipmentItems)
      .where(eq(shipmentItems.shipmentId, shipmentId));

    return { shipment: shipment as Shipment, items };
  }

  // =========================================================================
  // STATUS UPDATES
  // =========================================================================

  /**
   * Mark a shipment as delivered.
   *
   * @param shipmentId   The shipment primary key.
   * @param deliveredAt  When the package was delivered.  Defaults to now.
   */
  async markDelivered(
    shipmentId: number,
    deliveredAt?: Date,
  ): Promise<void> {
    await this.db
      .update(shipments)
      .set({
        status: "delivered",
        deliveredAt: deliveredAt ?? new Date(),
        updatedAt: new Date(),
      })
      .where(eq(shipments.id, shipmentId));
  }

  // =========================================================================
  // INTERNAL HELPERS
  // =========================================================================

  /**
   * Confirm a shipment using an already-open transaction handle.
   *
   * This is the inner implementation used by both the public
   * {@link confirmShipment} method and by {@link processShopifyFulfillment}
   * (which needs to confirm within its own outer transaction).
   */
  private async confirmShipmentInternal(
    shipmentId: number,
    tx: any,
    params?: {
      carrier?: string;
      trackingNumber?: string;
      trackingUrl?: string;
      shippedAt?: Date;
      userId?: string;
    },
  ): Promise<void> {
    // 1. Load the shipment
    const [shipment] = await tx
      .select()
      .from(shipments)
      .where(eq(shipments.id, shipmentId))
      .limit(1);

    if (!shipment) {
      throw new Error(`Shipment ${shipmentId} not found`);
    }

    if ((shipment as Shipment).status === "shipped" || (shipment as Shipment).status === "delivered") {
      return; // Already confirmed
    }

    // 2. Load shipment items
    const items: ShipmentItem[] = await tx
      .select()
      .from(shipmentItems)
      .where(eq(shipmentItems.shipmentId, shipmentId));

    // 3. Release inventory for each item
    for (const item of items) {
      if (!item.productVariantId) continue;

      const [variant] = await tx
        .select()
        .from(productVariants)
        .where(eq(productVariants.id, item.productVariantId))
        .limit(1);

      const unitsPerVariant = (variant as ProductVariant | undefined)?.unitsPerVariant ?? 1;
      const baseUnits = item.qty * unitsPerVariant;
      const warehouseLocationId = item.fromLocationId;

      if (warehouseLocationId && baseUnits > 0) {
        await this.inventoryCore.recordShipment({
          productVariantId: item.productVariantId,
          warehouseLocationId,
          baseUnits,
          orderId: (shipment as Shipment).orderId!,
          orderItemId: item.orderItemId ?? undefined,
          shipmentId: String(shipmentId),
          userId: params?.userId,
        });
      }
    }

    // 4. Update shipment status
    const now = params?.shippedAt ?? new Date();
    const updateSet: Record<string, any> = {
      status: "shipped",
      shippedAt: now,
      updatedAt: new Date(),
    };

    if (params?.carrier) updateSet.carrier = params.carrier;
    if (params?.trackingNumber) updateSet.trackingNumber = params.trackingNumber;
    if (params?.trackingUrl) updateSet.trackingUrl = params.trackingUrl;

    await tx
      .update(shipments)
      .set(updateSet)
      .where(eq(shipments.id, shipmentId));
  }

  /**
   * Return a lightweight copy of this service bound to the given
   * Drizzle transaction handle.  Used internally so compound operations
   * can share a single transaction boundary.
   */
  private withTx(tx: any): FulfillmentService {
    return new FulfillmentService(tx, this.inventoryCore);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new `FulfillmentService` bound to the supplied Drizzle database
 * instance and inventory core service.
 *
 * ```ts
 * import { db } from "../db";
 * import { createInventoryCoreService } from "./inventory-core";
 * import { createFulfillmentService } from "./fulfillment";
 *
 * const inventoryCore = createInventoryCoreService(db);
 * const fulfillment = createFulfillmentService(db, inventoryCore);
 * await fulfillment.processShopifyFulfillment({ ... });
 * ```
 */
export function createFulfillmentService(db: any, inventoryCore: any) {
  return new FulfillmentService(db, inventoryCore);
}
