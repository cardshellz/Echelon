import { sql } from "drizzle-orm";
import type { IInventoryStorage } from "../infrastructure/inventory.repository";
import type { InventoryLotService } from "../lots.service";
import type { COGSService } from "../cogs.service";
import { warehouses, warehouseLocations, channelConnections } from "../../../storage/base";
import { eq, and } from "drizzle-orm";
import { AuditLogger } from "../../../infrastructure/auditLogger";
import { IntegrityError, ValidationError } from "../../../../shared/errors";

/** Type wrapper for Drizzle database instance */
type DrizzleDb = {
  select: (...args: any[]) => any;
  update: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  execute: <T = any>(query: any) => Promise<{ rows: T[] }>;
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

export class InventoryUseCases {
  private onChangeCallbacks: ((productVariantId: number, triggeredBy: string) => void)[] = [];

  constructor(
    private readonly db: DrizzleDb,
    private readonly storage: IInventoryStorage,
    private readonly lotService: InventoryLotService | null = null,
    private readonly cogsService: COGSService | null = null,
  ) {}

  onInventoryChange(cb: (productVariantId: number, triggeredBy: string) => void): void {
    this.onChangeCallbacks.push(cb);
  }

  triggerNotifyChange(productVariantId: number, triggeredBy: string): void {
    for (const cb of this.onChangeCallbacks) {
      try {
        cb(productVariantId, triggeredBy);
      } catch (err: any) {
        console.warn(`[InventoryUseCases] onChange callback error: ${err.message}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // RECEIVE
  // ---------------------------------------------------------------------------

  async receiveInventory(params: {
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
    referenceId: string;
    notes?: string;
    userId?: string;
    unitCostCents?: number;
    receivingOrderId?: number;
    purchaseOrderId?: number;
    inboundShipmentId?: number;
    costProvisional?: number;
  }): Promise<void> {
    if (params.qty <= 0) throw new Error("qty must be a positive integer");

    await this.db.transaction(async (tx) => {
      // 1. Upsert Location Level
      const level = await this.storage.upsertInventoryLevel({
        productVariantId: params.productVariantId,
        warehouseLocationId: params.warehouseLocationId,
      }, tx);

      // 2. Adjust Balance
      await this.storage.adjustInventoryLevel(level.id, { variantQty: params.qty }, tx);

      // 3. FIFO Lot Generation
      let lotId: number | undefined;
      if (this.lotService) {
        const lotSvc = this.lotService.withTx(tx);
        const lot = await lotSvc.createLot({
          productVariantId: params.productVariantId,
          warehouseLocationId: params.warehouseLocationId,
          qty: params.qty,
          unitCostCents: params.unitCostCents ?? 0,
          receivingOrderId: params.receivingOrderId,
          purchaseOrderId: params.purchaseOrderId,
          inboundShipmentId: params.inboundShipmentId,
          costProvisional: params.costProvisional,
          notes: params.notes,
        });
        lotId = lot.id;

        if (params.unitCostCents !== undefined && params.unitCostCents > 0) {
          await lotSvc.updateVariantCosts(params.productVariantId, params.unitCostCents);
        }
      }

      // 4. Record Audit
      await this.storage.createInventoryTransaction({
        productVariantId: params.productVariantId,
        toLocationId: params.warehouseLocationId,
        transactionType: "receipt",
        variantQtyDelta: params.qty,
        variantQtyBefore: level.variantQty,
        variantQtyAfter: level.variantQty + params.qty,
        sourceState: "external",
        targetState: "on_hand",
        referenceType: "receiving",
        referenceId: params.referenceId,
        notes: params.notes ?? null,
        userId: params.userId ?? null,
        unitCostCents: params.unitCostCents ?? null,
        inventoryLotId: lotId ?? null,
      }, tx);
    });

    this.triggerNotifyChange(params.productVariantId, "receive");
  }

  // ---------------------------------------------------------------------------
  // PICK
  // ---------------------------------------------------------------------------

  async pickItem(params: {
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
    orderId: number;
    orderItemId?: number;
    userId?: string;
  }): Promise<boolean> {
    if (params.qty <= 0) throw new Error("qty must be a positive integer");

    const result = await this.db.transaction(async (tx) => {
      const level = await this.storage.getInventoryLevelByLocationAndVariant(
        params.warehouseLocationId,
        params.productVariantId
      );

      if (!level) return false;

      // Ensure enough stock exists (optimistic application-layer lock)
      if (level.variantQty < params.qty) {
        return false;
      }

      const reservationRelease = Math.min(level.reservedQty, params.qty);

      // Adjust Buckets (Storage level enforces non-negative natively usually, but we check here)
      await this.storage.adjustInventoryLevel(level.id, {
        variantQty: -params.qty,
        pickedQty: params.qty,
        ...(reservationRelease > 0 ? { reservedQty: -reservationRelease } : {})
      }, tx);

      // COGS / FIFO Pick
      if (this.lotService) {
        const lotSvc = this.lotService.withTx(tx);
        await lotSvc.pickFromLots({
          productVariantId: params.productVariantId,
          warehouseLocationId: params.warehouseLocationId,
          qty: params.qty,
          orderId: params.orderId,
          orderItemId: params.orderItemId,
        });
      }

      // Audit log
      await this.storage.createInventoryTransaction({
        productVariantId: params.productVariantId,
        fromLocationId: params.warehouseLocationId,
        transactionType: "pick",
        variantQtyDelta: -params.qty,
        variantQtyBefore: level.variantQty,
        variantQtyAfter: level.variantQty - params.qty,
        sourceState: "on_hand",
        targetState: "picked",
        orderId: params.orderId,
        orderItemId: params.orderItemId ?? null,
        referenceType: "order",
        referenceId: String(params.orderId),
        userId: params.userId ?? null,
      }, tx);

      return true;
    });

    return result;
  }

  // ---------------------------------------------------------------------------
  // SHIP
  // ---------------------------------------------------------------------------

  async recordShipment(params: {
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
    orderId: number;
    orderItemId?: number;
    shipmentId?: string;
    userId?: string;
  }): Promise<void> {
    if (params.qty <= 0) throw new Error("qty must be a positive integer");

    await this.db.transaction(async (tx) => {
      const level = await this.storage.getInventoryLevelByLocationAndVariant(
        params.warehouseLocationId,
        params.productVariantId
      );

      if (!level) {
        throw new Error(`No inventory level for variant ${params.productVariantId} at location ${params.warehouseLocationId}`);
      }

      const fromPicked = Math.min(level.pickedQty, params.qty);
      let fromOnHand = params.qty - fromPicked;

      if (fromOnHand > level.variantQty) {
        throw new IntegrityError(
          `Negative Inventory Guard: Cannot record shipment of ${params.qty}. Picked: ${fromPicked}, On-hand: ${level.variantQty}, Required from on-hand: ${fromOnHand}.`
        );
      }

      if (fromPicked > 0) {
        await this.storage.adjustInventoryLevel(level.id, { pickedQty: -fromPicked }, tx);
      }

      if (fromOnHand > 0) {
        const reservedToRelease = Math.min(level.reservedQty, fromOnHand);
        await this.storage.adjustInventoryLevel(level.id, {
          variantQty: -fromOnHand,
          ...(reservedToRelease > 0 ? { reservedQty: -reservedToRelease } : {}),
        }, tx);
      }

      if (this.lotService) {
        const lotSvc = this.lotService.withTx(tx);
        await lotSvc.shipFromLots({
          productVariantId: params.productVariantId,
          warehouseLocationId: params.warehouseLocationId,
          qty: params.qty,
        });
      }

      if (this.cogsService && params.orderId) {
        const cogsSvc = (this.cogsService as any).withTx ? (this.cogsService as any).withTx(tx) : this.cogsService;
        await cogsSvc.recordShipmentCOGS({
          orderId: params.orderId,
          orderItemId: params.orderItemId,
          productVariantId: params.productVariantId,
          qty: params.qty,
        });
      }

      await this.storage.createInventoryTransaction({
        productVariantId: params.productVariantId,
        fromLocationId: params.warehouseLocationId,
        transactionType: "ship",
        variantQtyDelta: -params.qty,
        variantQtyBefore: level.variantQty,
        variantQtyAfter: level.variantQty - fromOnHand,
        sourceState: fromOnHand > 0 ? "on_hand" : "picked",
        targetState: "shipped",
        orderId: params.orderId,
        orderItemId: params.orderItemId ?? null,
        referenceType: "order",
        referenceId: params.shipmentId ?? String(params.orderId),
        userId: params.userId ?? null,
        notes: fromOnHand > 0 ? `Shipped without pick: ${fromPicked} from picked, ${fromOnHand} from on-hand` : null,
      }, tx);
    });
  }

  // ---------------------------------------------------------------------------
  // ADJUSTMENT
  // ---------------------------------------------------------------------------

  async adjustInventory(params: {
    productVariantId: number;
    warehouseLocationId: number;
    qtyDelta: number;
    reason: string;
    reasonId?: number;
    cycleCountId?: number;
    userId?: string;
    allowNegative?: boolean;
  }): Promise<void> {
    if (params.qtyDelta === 0) throw new Error("qtyDelta must be non-zero");

    await this.db.transaction(async (tx) => {
      const level = await this.storage.upsertInventoryLevel({
        productVariantId: params.productVariantId,
        warehouseLocationId: params.warehouseLocationId,
      }, tx);

      if (!params.allowNegative && params.qtyDelta < 0) {
        if (level.variantQty + params.qtyDelta < 0) {
          throw new Error(`Adjustment would result in negative inventory`);
        }
      }

      await this.storage.adjustInventoryLevel(level.id, { variantQty: params.qtyDelta }, tx);

      if (this.lotService) {
        const lotSvc = this.lotService.withTx(tx);
        await lotSvc.adjustLots({
          productVariantId: params.productVariantId,
          warehouseLocationId: params.warehouseLocationId,
          qtyDelta: params.qtyDelta,
          notes: params.reason,
        });
      }

      await this.storage.createInventoryTransaction({
        productVariantId: params.productVariantId,
        fromLocationId: params.qtyDelta < 0 ? params.warehouseLocationId : null,
        toLocationId: params.qtyDelta > 0 ? params.warehouseLocationId : null,
        transactionType: "adjustment",
        reasonId: params.reasonId ?? null,
        variantQtyDelta: params.qtyDelta,
        variantQtyBefore: level.variantQty,
        variantQtyAfter: level.variantQty + params.qtyDelta,
        sourceState: "on_hand",
        targetState: "on_hand",
        cycleCountId: params.cycleCountId ?? null,
        referenceType: params.cycleCountId ? "cycle_count" : "manual",
        referenceId: params.cycleCountId ? String(params.cycleCountId) : null,
        notes: params.reason,
        userId: params.userId ?? null,
      }, tx);
    });

    this.triggerNotifyChange(params.productVariantId, "adjustment");
  }

  // ---------------------------------------------------------------------------
  // RESERVE
  // ---------------------------------------------------------------------------

  async reserveForOrder(params: {
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
    orderId: number;
    orderItemId: number;
    userId?: string;
  }): Promise<boolean> {
    if (params.qty <= 0) throw new Error("qty must be a positive integer");

    const result = await this.db.transaction(async (tx) => {
      const level = await this.storage.upsertInventoryLevel({
        productVariantId: params.productVariantId,
        warehouseLocationId: params.warehouseLocationId,
      }, tx);

      await this.storage.adjustInventoryLevel(level.id, { reservedQty: params.qty }, tx);

      if (this.lotService) {
        const lotSvc = this.lotService.withTx(tx);
        await lotSvc.reserveFromLots({
          productVariantId: params.productVariantId,
          warehouseLocationId: params.warehouseLocationId,
          qty: params.qty,
        });
      }

      await this.storage.createInventoryTransaction({
        productVariantId: params.productVariantId,
        toLocationId: params.warehouseLocationId,
        transactionType: "reserve",
        variantQtyDelta: 0,
        variantQtyBefore: level.variantQty,
        variantQtyAfter: level.variantQty,
        sourceState: "on_hand",
        targetState: "committed",
        orderId: params.orderId,
        orderItemId: params.orderItemId,
        referenceType: "order",
        referenceId: String(params.orderId),
        userId: params.userId ?? null,
      }, tx);

      return true;
    });

    this.triggerNotifyChange(params.productVariantId, "reserve");
    return result;
  }

  async releaseReservation(params: {
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
    orderId: number;
    orderItemId: number;
    reason: string;
    userId?: string;
  }): Promise<void> {
    if (params.qty <= 0) throw new Error("qty must be a positive integer");

    await this.db.transaction(async (tx) => {
      const level = await this.storage.getInventoryLevelByLocationAndVariant(
        params.warehouseLocationId,
        params.productVariantId
      );

      if (!level) throw new Error(`No inventory level`);
      if (level.reservedQty < params.qty) throw new Error(`Cannot release ${params.qty} reserved units`);

      await this.storage.adjustInventoryLevel(level.id, { reservedQty: -params.qty }, tx);

      if (this.lotService) {
        const lotSvc = this.lotService.withTx(tx);
        await lotSvc.releaseFromLots({
          productVariantId: params.productVariantId,
          warehouseLocationId: params.warehouseLocationId,
          qty: params.qty,
        });
      }

      await this.storage.createInventoryTransaction({
        productVariantId: params.productVariantId,
        fromLocationId: params.warehouseLocationId,
        transactionType: "unreserve",
        variantQtyDelta: 0,
        variantQtyBefore: level.variantQty,
        variantQtyAfter: level.variantQty,
        sourceState: "committed",
        targetState: "on_hand",
        orderId: params.orderId,
        orderItemId: params.orderItemId,
        referenceType: "order",
        referenceId: String(params.orderId),
        notes: params.reason,
        userId: params.userId ?? null,
      }, tx);
    });

    this.triggerNotifyChange(params.productVariantId, "unreserve");
  }

  // ---------------------------------------------------------------------------
  // TRANSFER
  // ---------------------------------------------------------------------------

  async transfer(params: {
    productVariantId: number;
    fromLocationId: number;
    toLocationId: number;
    qty: number;
    userId?: string;
    notes?: string;
  }): Promise<void> {
    if (params.qty <= 0) throw new Error("qty must be a positive integer");
    if (params.fromLocationId === params.toLocationId) throw new Error("Source and destination must differ");

    await this.db.transaction(async (tx) => {
      const sourceLevel = await this.storage.getInventoryLevelByLocationAndVariant(
        params.fromLocationId,
        params.productVariantId
      );

      if (!sourceLevel || sourceLevel.variantQty < params.qty) {
        throw new Error(`Insufficient on-hand at source: need ${params.qty}`);
      }

      const decremented = await this.storage.adjustInventoryLevel(sourceLevel.id, { variantQty: -params.qty }, tx);

      const targetLevel = await this.storage.upsertInventoryLevel({
        productVariantId: params.productVariantId,
        warehouseLocationId: params.toLocationId,
      }, tx);

      await this.storage.adjustInventoryLevel(targetLevel.id, { variantQty: params.qty }, tx);

      if (this.lotService) {
        const lotSvc = this.lotService.withTx(tx);
        await lotSvc.transferLots({
          productVariantId: params.productVariantId,
          fromLocationId: params.fromLocationId,
          toLocationId: params.toLocationId,
          qty: params.qty,
          notes: params.notes,
        });
      }

      await this.storage.createInventoryTransaction({
        productVariantId: params.productVariantId,
        fromLocationId: params.fromLocationId,
        toLocationId: params.toLocationId,
        transactionType: "transfer",
        variantQtyDelta: params.qty,
        variantQtyBefore: sourceLevel.variantQty,
        variantQtyAfter: sourceLevel.variantQty - params.qty,
        sourceState: "on_hand",
        targetState: "on_hand",
        referenceType: "internal",
        referenceId: null,
        notes: params.notes ?? null,
        userId: params.userId ?? null,
      }, tx);
    });

    this.triggerNotifyChange(params.productVariantId, "transfer");
  }

  // ---------------------------------------------------------------------------
  // SKU CONVERSION
  // ---------------------------------------------------------------------------

  async convertSku(params: {
    fromVariantId: number;
    toVariantId: number;
    locationId?: number;
    quantity?: number;
    notes?: string;
    userId?: string;
  }): Promise<{ totalConverted: number; conversions: { locationCode: string; qty: number }[]; batchId: string }> {
    if (params.fromVariantId === params.toVariantId) {
      throw new ValidationError("Source and destination variants must be different");
    }

    const convertQty = params.quantity ?? null;
    if (convertQty !== null && convertQty <= 0) {
      throw new ValidationError("Quantity must be a positive integer");
    }

    const batchId = `skuconv-${Date.now()}`;
    const conversions: { locationCode: string; qty: number }[] = [];

    const result = await this.db.transaction(async (tx) => {
      // Find all inventory for the source variant
      const sourceInventoryResp = await tx.execute(sql`
        SELECT
          il.warehouse_location_id as warehouse_location_id,
          il.variant_qty as variant_qty,
          wl.code as location_code
        FROM inventory_levels il
        JOIN warehouse_locations wl ON il.warehouse_location_id = wl.id
        WHERE il.product_variant_id = ${params.fromVariantId}
          ${params.locationId ? sql`AND il.warehouse_location_id = ${params.locationId}` : sql``}
          AND il.variant_qty > 0
      `);
      
      const sourceInventory = sourceInventoryResp.rows;
      if (sourceInventory.length === 0) {
        throw new IntegrityError("No inventory found for source variant");
      }

      const totalAvailable = sourceInventory.reduce((s: number, l: any) => s + Number(l.variant_qty), 0);
      if (convertQty !== null && convertQty > totalAvailable) {
        throw new IntegrityError(`Requested ${convertQty} but only ${totalAvailable} available`);
      }

      let remaining = convertQty ?? totalAvailable;

      for (const inv of sourceInventory) {
        if (remaining <= 0) break;
        const qtyToConvert = Math.min(Number(inv.variant_qty), remaining);

        // Adjust-out from old variant
        const sourceLevel = await this.storage.upsertInventoryLevel({
          productVariantId: params.fromVariantId,
          warehouseLocationId: inv.warehouse_location_id,
        }, tx);
        
        await this.storage.adjustInventoryLevel(sourceLevel.id, { variantQty: -qtyToConvert }, tx);
        
        await this.storage.createInventoryTransaction({
          productVariantId: params.fromVariantId,
          fromLocationId: inv.warehouse_location_id,
          transactionType: "sku_correction",
          variantQtyDelta: -qtyToConvert,
          variantQtyBefore: sourceLevel.variantQty,
          variantQtyAfter: sourceLevel.variantQty - qtyToConvert,
          sourceState: "on_hand",
          targetState: "on_hand",
          batchId,
          referenceType: "sku_conversion",
          referenceId: `${params.fromVariantId}→${params.toVariantId}`,
          notes: params.notes ?? null,
          userId: params.userId ?? null,
        }, tx);

        // Adjust-in to new variant
        const destLevel = await this.storage.upsertInventoryLevel({
          productVariantId: params.toVariantId,
          warehouseLocationId: inv.warehouse_location_id,
        }, tx);
        
        await this.storage.adjustInventoryLevel(destLevel.id, { variantQty: qtyToConvert }, tx);
        
        await this.storage.createInventoryTransaction({
          productVariantId: params.toVariantId,
          toLocationId: inv.warehouse_location_id,
          transactionType: "sku_correction",
          variantQtyDelta: qtyToConvert,
          variantQtyBefore: destLevel.variantQty,
          variantQtyAfter: destLevel.variantQty + qtyToConvert,
          sourceState: "on_hand",
          targetState: "on_hand",
          batchId,
          referenceType: "sku_conversion",
          referenceId: `${params.fromVariantId}→${params.toVariantId}`,
          notes: params.notes ?? null,
          userId: params.userId ?? null,
        }, tx);

        // Cleanup empty source
        if (sourceLevel.variantQty - qtyToConvert <= 0) {
          const hasAssignment = await tx.execute(sql`
            SELECT 1 FROM product_locations
            WHERE product_variant_id = ${params.fromVariantId}
              AND warehouse_location_id = ${inv.warehouse_location_id}
            LIMIT 1
          `);
          if (hasAssignment.rows.length === 0) {
            await tx.execute(sql`DELETE FROM inventory_levels WHERE id = ${sourceLevel.id}`);
          }
        }

        conversions.push({ locationCode: inv.location_code, qty: qtyToConvert });
        remaining -= qtyToConvert;
      }
      
      return { totalConverted: conversions.reduce((s, c) => s + c.qty, 0), conversions, batchId };
    });

    AuditLogger.log({
      actor: params.userId || "system",
      action: "convert_sku",
      target: `variant_${params.fromVariantId}_to_${params.toVariantId}`,
      changes: {
        before: { variant_id: params.fromVariantId },
        after: { variant_id: params.toVariantId, amount_converted: result.totalConverted }
      }
    });

    this.triggerNotifyChange(params.fromVariantId, "convert-sku-out");
    this.triggerNotifyChange(params.toVariantId, "convert-sku-in");

    return result;
  }

  // ---------------------------------------------------------------------------
  // EXTERNAL SOURCE SYNC
  // ---------------------------------------------------------------------------

  async syncWarehouse(warehouseId: number): Promise<any> {
    const [wh] = await this.db.select().from(warehouses).where(eq(warehouses.id, warehouseId)).limit(1);
    if (!wh) throw new Error(`Warehouse ${warehouseId} not found`);

    const result = {
      warehouseId: wh.id,
      warehouseCode: wh.code,
      synced: 0,
      skipped: 0,
      errors: [] as string[],
    };

    if (wh.inventorySourceType === "internal" || wh.inventorySourceType === "manual") {
      result.errors.push(`Warehouse ${wh.code} has source type '${wh.inventorySourceType}'`);
      return result;
    }

    if (wh.inventorySourceType !== "channel") {
      result.errors.push(`Only channel is supported currently (Shopify).`);
      return result;
    }

    try {
      await this.db.update(warehouses)
        .set({ inventorySyncStatus: "syncing", updatedAt: new Date() })
        .where(eq(warehouses.id, warehouseId));

      const config = (wh.inventorySourceConfig as Record<string, any>) || {};
      const channelId = config?.channelId;
      if (!channelId) throw new Error(`No channelId configured for warehouse ${warehouseId}`);

      const [conn] = await this.db.select()
        .from(channelConnections)
        .where(eq(channelConnections.channelId, channelId)).limit(1);

      if (!conn?.shopDomain || !conn?.accessToken) {
        throw new Error(`Shopify credentials missing for channel ${channelId}`);
      }

      const shopifyLocationId = wh.shopifyLocationId;
      const apiVersion = conn.apiVersion || "2024-01";
      const items = new Map<string, number>();
      let pageInfo: string | null = null;
      let hasMore = true;

      while (hasMore) {
        const url: string = pageInfo
          ? `https://${conn.shopDomain}/admin/api/${apiVersion}/inventory_levels.json?page_info=${pageInfo}&limit=250`
          : `https://${conn.shopDomain}/admin/api/${apiVersion}/inventory_levels.json?location_ids=${shopifyLocationId}&limit=250`;

        const response = await fetch(url, {
          headers: {
            "X-Shopify-Access-Token": conn.accessToken,
            "Content-Type": "application/json",
          },
        });

        if (!response.ok) throw new Error(`Shopify API error: ${response.status} ${response.statusText}`);

        const data = await response.json();
        const levels = data.inventory_levels || [];

        for (const level of levels) {
          items.set(String(level.inventory_item_id), level.available ?? 0);
        }

        const linkHeader: string | null = response.headers.get("Link");
        if (linkHeader?.includes('rel="next"')) {
          const match: RegExpMatchArray | null = linkHeader.match(/<[^>]*page_info=([^>&]*).*?>;\s*rel="next"/);
          pageInfo = match?.[1] || null;
          hasMore = !!pageInfo;
        } else {
          hasMore = false;
        }
      }

      // Ensure a virtual location
      const virtualCode = `${wh.code}-VIRTUAL`;
      const [existingLoc] = await this.db.select()
        .from(warehouseLocations)
        .where(and(eq(warehouseLocations.warehouseId, warehouseId), eq(warehouseLocations.locationType, "3pl_virtual")))
        .limit(1);

      let virtualLocationId = existingLoc?.id;
      if (!virtualLocationId) {
        const [createdLoc] = await this.db.insert(warehouseLocations).values({
          warehouseId,
          code: virtualCode,
          name: `${wh.code} Virtual Inventory`,
          locationType: "3pl_virtual",
          binType: "floor",
          isPickable: 0,
        }).returning();
        virtualLocationId = createdLoc.id;
      }

      const inventoryItemIds = Array.from(items.keys());
      if (inventoryItemIds.length > 0) {
        const variants = await this.db.execute<{ id: number; shopify_inventory_item_id: string; }>(sql`
          SELECT id, shopify_inventory_item_id FROM product_variants
          WHERE shopify_inventory_item_id IN (${sql.join(inventoryItemIds.map(id => sql`${id}`), sql`, `)})
        `);

        const variantMap = new Map(variants.rows.map(v => [v.shopify_inventory_item_id, v.id]));

        for (const [inventoryItemId, qty] of items) {
          const variantId = variantMap.get(inventoryItemId);
          if (!variantId) {
            result.skipped++;
            continue;
          }

          try {
            const currentLevel = await this.storage.getInventoryLevelByLocationAndVariant(virtualLocationId, variantId);
            const oldQty = currentLevel?.variantQty ?? 0;
            const delta = qty - oldQty;

            if (delta !== 0) {
              await this.adjustInventory({
                productVariantId: variantId,
                warehouseLocationId: virtualLocationId,
                qtyDelta: delta,
                reason: `3PL sync (set to ${qty}, delta ${delta > 0 ? "+" : ""}${delta})`,
                allowNegative: true,
              });
            }
            result.synced++;
          } catch (err: any) {
            result.errors.push(`Variant ${variantId}: ${err.message}`);
          }
        }
      }

      await this.db.update(warehouses)
        .set({ inventorySyncStatus: "ok", lastInventorySyncAt: new Date(), updatedAt: new Date() })
        .where(eq(warehouses.id, warehouseId));

    } catch (err: any) {
      await this.db.update(warehouses)
        .set({ inventorySyncStatus: "error", updatedAt: new Date() })
        .where(eq(warehouses.id, warehouseId));
      result.errors.push(err.message);
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // INTERNAL: transaction-scoped clone
  // ---------------------------------------------------------------------------

  withTx(tx: any): InventoryUseCases {
    return new InventoryUseCases(
      tx as DrizzleDb,
      this.storage,
      this.lotService,
      this.cogsService
    );
  }
}
