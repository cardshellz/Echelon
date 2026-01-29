import { storage } from "./storage";
import type { 
  InventoryItem, 
  UomVariant, 
  InventoryLevel, 
  InventoryTransaction,
  InsertInventoryTransaction 
} from "@shared/schema";

export interface VariantAvailability {
  variantId: number;
  sku: string;
  name: string;
  unitsPerVariant: number;
  available: number;
  onHandBase: number;
  reservedBase: number;
  atpBase: number;
  variantQty: number; // Physical count of this variant across all locations
}

export interface InventoryItemSummary {
  inventoryItemId: number;
  baseSku: string;
  name: string;
  totalOnHandBase: number;
  totalReservedBase: number;
  totalAtpBase: number;
  variants: VariantAvailability[];
}

export class InventoryService {
  
  /**
   * Calculate Available-to-Promise (ATP) for a base inventory item
   * ATP = On Hand (pickable locations) - Reserved
   */
  async calculateATP(inventoryItemId: number): Promise<number> {
    const onHand = await storage.getTotalOnHandByItemId(inventoryItemId, false);
    const reserved = await storage.getTotalReservedByItemId(inventoryItemId);
    return onHand - reserved;
  }

  /**
   * Calculate available quantity for each UOM variant based on base ATP
   * Returns floor(ATP / units_per_variant) for each variant
   * Also includes physical variant quantity from inventory levels
   */
  async calculateVariantAvailability(inventoryItemId: number): Promise<VariantAvailability[]> {
    const variants = await storage.getUomVariantsByInventoryItemId(inventoryItemId);
    const levels = await storage.getInventoryLevelsByItemId(inventoryItemId);
    const atp = await this.calculateATP(inventoryItemId);
    const onHand = await storage.getTotalOnHandByItemId(inventoryItemId, false);
    const reserved = await storage.getTotalReservedByItemId(inventoryItemId);
    
    return variants.map(variant => {
      // Sum variantQty across all locations for this variant
      const variantLevels = levels.filter(l => l.variantId === variant.id);
      const totalVariantQty = variantLevels.reduce((sum, l) => sum + (l.variantQty || 0), 0);
      
      return {
        variantId: variant.id,
        sku: variant.sku,
        name: variant.name,
        unitsPerVariant: variant.unitsPerVariant,
        available: Math.floor(atp / variant.unitsPerVariant),
        onHandBase: onHand,
        reservedBase: reserved,
        atpBase: atp,
        variantQty: totalVariantQty,
      };
    });
  }

  /**
   * Get full inventory summary for an item including all variant availability
   */
  async getInventoryItemSummary(inventoryItemId: number): Promise<InventoryItemSummary | null> {
    const items = await storage.getAllInventoryItems();
    const item = items.find(i => i.id === inventoryItemId);
    if (!item) return null;

    const variants = await this.calculateVariantAvailability(inventoryItemId);
    const onHand = await storage.getTotalOnHandByItemId(inventoryItemId, false);
    const reserved = await storage.getTotalReservedByItemId(inventoryItemId);
    
    return {
      inventoryItemId: item.id,
      baseSku: item.baseSku,
      name: item.name,
      totalOnHandBase: onHand,
      totalReservedBase: reserved,
      totalAtpBase: onHand - reserved,
      variants,
    };
  }

  /**
   * Reserve base units for an order at a specific location
   * Increases reservedBase by delta, decreasing ATP
   * ATP = onHand - reserved, so increasing reserved decreases ATP
   * Returns true if reservation successful
   */
  async reserveForOrder(
    inventoryItemId: number,
    warehouseLocationId: number,
    baseUnits: number,
    orderId: number,
    orderItemId: number,
    userId?: string
  ): Promise<boolean> {
    const levels = await storage.getInventoryLevelsByItemId(inventoryItemId);
    const levelAtLocation = levels.find(l => l.warehouseLocationId === warehouseLocationId);
    
    if (!levelAtLocation) {
      console.log(`[Inventory] No inventory level at location ${warehouseLocationId} for item ${inventoryItemId}`);
      return false;
    }

    // Delta: add to reserved (storage adds this to current value)
    await storage.adjustInventoryLevel(levelAtLocation.id, { 
      reservedBase: baseUnits 
    });

    await this.logTransaction({
      inventoryItemId,
      warehouseLocationId,
      transactionType: "reserve",
      baseQtyDelta: baseUnits,
      sourceState: "on_hand",
      targetState: "reserved",
      orderId,
      orderItemId,
      referenceType: "order",
      userId,
      isImplicit: 0,
    });

    return true;
  }

  /**
   * Release reservation at a specific location (e.g., order cancelled or short pick)
   * Decreases reservedBase, increasing ATP
   */
  async releaseReservation(
    inventoryItemId: number,
    warehouseLocationId: number,
    baseUnits: number,
    orderId: number,
    orderItemId: number,
    reason: string,
    userId?: string
  ): Promise<void> {
    const levels = await storage.getInventoryLevelsByItemId(inventoryItemId);
    const levelAtLocation = levels.find(l => l.warehouseLocationId === warehouseLocationId);
    
    if (levelAtLocation) {
      // Delta: subtract from reserved (negative delta)
      await storage.adjustInventoryLevel(levelAtLocation.id, { reservedBase: -baseUnits });
    }

    await this.logTransaction({
      inventoryItemId,
      warehouseLocationId,
      transactionType: "unreserve",
      baseQtyDelta: -baseUnits,
      sourceState: "reserved",
      targetState: "on_hand",
      orderId,
      orderItemId,
      referenceType: "order",
      notes: reason,
      userId,
      isImplicit: 0,
    });
  }

  /**
   * Pick item from a specific location (implicit workflow - no pre-reservation required)
   * This: decrements onHand, increments picked
   * If there was a reservation, also decrements reserved
   */
  async pickItem(
    inventoryItemId: number,
    warehouseLocationId: number,
    baseUnits: number,
    orderId: number,
    userId?: string
  ): Promise<boolean> {
    const levels = await storage.getInventoryLevelsByItemId(inventoryItemId);
    const levelAtLocation = levels.find(l => l.warehouseLocationId === warehouseLocationId);
    
    if (!levelAtLocation) {
      console.log(`[Inventory] No inventory level at location ${warehouseLocationId} for item ${inventoryItemId}`);
      return false;
    }

    // Deltas for picking:
    // - onHand decreases (negative delta)
    // - picked increases (positive delta)
    // - If reserved exists, decrease it (negative delta) 
    const reservedToRelease = Math.min(levelAtLocation.reservedBase, baseUnits);

    await storage.adjustInventoryLevel(levelAtLocation.id, { 
      onHandBase: -baseUnits,
      pickedBase: baseUnits,
      reservedBase: -reservedToRelease
    });

    await this.logTransaction({
      inventoryItemId,
      warehouseLocationId,
      transactionType: "pick",
      baseQtyDelta: -baseUnits,
      sourceState: "on_hand",
      targetState: "picked",
      orderId,
      referenceType: "order",
      userId,
      isImplicit: 1, // Implicit movement from picking action
    });

    return true;
  }

  /**
   * Complete shipment - move units from picked to shipped
   * Decrements picked (items leave the building)
   */
  async recordShipment(
    inventoryItemId: number,
    warehouseLocationId: number,
    baseUnits: number,
    orderId: number,
    orderItemId: number,
    userId?: string
  ): Promise<void> {
    const levels = await storage.getInventoryLevelsByItemId(inventoryItemId);
    const levelAtLocation = levels.find(l => l.warehouseLocationId === warehouseLocationId);
    
    if (levelAtLocation) {
      // Delta: subtract from picked (negative delta)
      await storage.adjustInventoryLevel(levelAtLocation.id, { pickedBase: -baseUnits });
    }

    await this.logTransaction({
      inventoryItemId,
      warehouseLocationId,
      transactionType: "ship",
      baseQtyDelta: -baseUnits,
      sourceState: "picked",
      targetState: "shipped",
      orderId,
      orderItemId,
      referenceType: "order",
      userId,
      isImplicit: 0,
    });
  }

  /**
   * Receive inventory from PO
   */
  async receiveInventory(
    inventoryItemId: number,
    warehouseLocationId: number,
    baseUnits: number,
    referenceId: string,
    notes?: string,
    userId?: string,
    variantId?: number,
    variantQty?: number
  ): Promise<void> {
    const existing = await storage.getInventoryLevelsByItemId(inventoryItemId);
    
    // If receiving by variant, find/create level for that specific variant
    const levelAtLocation = variantId 
      ? existing.find(l => l.warehouseLocationId === warehouseLocationId && l.variantId === variantId)
      : existing.find(l => l.warehouseLocationId === warehouseLocationId);
    
    if (levelAtLocation) {
      // Delta: add to onHand (positive delta) and variantQty if provided
      const adjustments: any = { onHandBase: baseUnits };
      if (variantQty !== undefined) {
        adjustments.variantQty = variantQty;
      }
      await storage.adjustInventoryLevel(levelAtLocation.id, adjustments);
    } else {
      await storage.upsertInventoryLevel({
        inventoryItemId,
        warehouseLocationId,
        variantId: variantId || null,
        variantQty: variantQty || 0,
        onHandBase: baseUnits,
        reservedBase: 0,
        pickedBase: 0,
        packedBase: 0,
        backorderBase: 0,
      });
    }

    await this.logTransaction({
      inventoryItemId,
      warehouseLocationId,
      variantId: variantId || undefined,
      transactionType: "receipt",
      baseQtyDelta: baseUnits,
      targetState: "on_hand",
      referenceType: "po",
      referenceId,
      notes,
      userId,
      isImplicit: 0,
    });
  }

  /**
   * Manual adjustment (cycle count, write-off, etc.)
   */
  async adjustInventory(
    inventoryItemId: number,
    warehouseLocationId: number,
    baseUnitsDelta: number,
    reason: string,
    userId?: string
  ): Promise<void> {
    const levels = await storage.getInventoryLevelsByItemId(inventoryItemId);
    const levelAtLocation = levels.find(l => l.warehouseLocationId === warehouseLocationId);
    
    if (levelAtLocation) {
      // Delta: add the adjustment (can be positive or negative)
      await storage.adjustInventoryLevel(levelAtLocation.id, { onHandBase: baseUnitsDelta });
    } else if (baseUnitsDelta > 0) {
      await storage.upsertInventoryLevel({
        inventoryItemId,
        warehouseLocationId,
        onHandBase: baseUnitsDelta,
        reservedBase: 0,
        pickedBase: 0,
        packedBase: 0,
        backorderBase: 0,
      });
    }

    await this.logTransaction({
      inventoryItemId,
      warehouseLocationId,
      transactionType: "adjustment",
      baseQtyDelta: baseUnitsDelta,
      sourceState: "on_hand",
      targetState: "on_hand",
      notes: reason,
      userId,
      isImplicit: 0,
    });
  }

  /**
   * Get sibling variant IDs (other variants of the same base SKU)
   */
  async getSiblingVariants(variantId: number): Promise<UomVariant[]> {
    const allVariants = await storage.getAllUomVariants();
    const variant = allVariants.find(v => v.id === variantId);
    if (!variant) return [];
    
    return allVariants.filter(v => 
      v.inventoryItemId === variant.inventoryItemId && v.id !== variantId
    );
  }

  /**
   * Convert variant quantity to base units
   */
  async convertToBaseUnits(variantId: number, quantity: number): Promise<number> {
    const allVariants = await storage.getAllUomVariants();
    const variant = allVariants.find(v => v.id === variantId);
    if (!variant) return 0;
    return quantity * variant.unitsPerVariant;
  }

  /**
   * Replenish a pickable location from its parent (bulk) location
   * Used when a forward pick bin is empty/low
   * Returns the number of base units replenished
   */
  async replenishLocation(
    inventoryItemId: number,
    targetLocationId: number,
    requestedUnits: number,
    userId?: string
  ): Promise<{ replenished: number; sourceLocationId: number | null }> {
    // Get the target location to find its parent
    const targetLocation = await storage.getWarehouseLocationById(targetLocationId);
    if (!targetLocation) {
      console.log(`[Replenish] Target location ${targetLocationId} not found`);
      return { replenished: 0, sourceLocationId: null };
    }

    // Get parent location (bulk storage)
    const parentLocationId = targetLocation.parentLocationId;
    if (!parentLocationId) {
      console.log(`[Replenish] No parent location configured for ${targetLocation.code}`);
      return { replenished: 0, sourceLocationId: null };
    }

    // Check parent location inventory
    const levels = await storage.getInventoryLevelsByItemId(inventoryItemId);
    const parentLevel = levels.find(l => l.warehouseLocationId === parentLocationId);
    
    if (!parentLevel || parentLevel.onHandBase <= 0) {
      console.log(`[Replenish] Parent location has no stock for item ${inventoryItemId}`);
      return { replenished: 0, sourceLocationId: parentLocationId };
    }

    // Calculate how much we can replenish (up to what's available)
    const replenishAmount = Math.min(requestedUnits, parentLevel.onHandBase);

    // Decrement from parent (bulk)
    await storage.adjustInventoryLevel(parentLevel.id, { onHandBase: -replenishAmount });

    // Increment at target (pickable)
    const targetLevel = levels.find(l => l.warehouseLocationId === targetLocationId);
    if (targetLevel) {
      await storage.adjustInventoryLevel(targetLevel.id, { onHandBase: replenishAmount });
    } else {
      await storage.upsertInventoryLevel({
        inventoryItemId,
        warehouseLocationId: targetLocationId,
        onHandBase: replenishAmount,
        reservedBase: 0,
        pickedBase: 0,
        packedBase: 0,
        backorderBase: 0,
      });
    }

    // Log the replenishment transaction
    await this.logTransaction({
      inventoryItemId,
      warehouseLocationId: targetLocationId,
      transactionType: "replenish",
      baseQtyDelta: replenishAmount,
      sourceState: "on_hand",
      targetState: "on_hand",
      notes: `Replenished from location ${parentLocationId}`,
      userId,
      isImplicit: 1, // Implicit movement
    });

    console.log(`[Replenish] Moved ${replenishAmount} units from location ${parentLocationId} to ${targetLocationId}`);
    return { replenished: replenishAmount, sourceLocationId: parentLocationId };
  }

  /**
   * Check if an inventory item has negative ATP (backorder situation)
   * Returns the backorder quantity if negative, otherwise 0
   */
  async checkBackorderStatus(inventoryItemId: number): Promise<{ 
    isBackordered: boolean; 
    backorderQty: number;
    atp: number;
  }> {
    const atp = await this.calculateATP(inventoryItemId);
    const isBackordered = atp < 0;
    const backorderQty = isBackordered ? Math.abs(atp) : 0;
    
    return { isBackordered, backorderQty, atp };
  }

  /**
   * Record backorder demand for an item at a location
   * Used when we accept orders we can't immediately fulfill
   */
  async recordBackorder(
    inventoryItemId: number,
    warehouseLocationId: number,
    baseUnits: number,
    orderId: number,
    orderItemId: number,
    userId?: string
  ): Promise<void> {
    const levels = await storage.getInventoryLevelsByItemId(inventoryItemId);
    const levelAtLocation = levels.find(l => l.warehouseLocationId === warehouseLocationId);
    
    if (levelAtLocation) {
      await storage.adjustInventoryLevel(levelAtLocation.id, { backorderBase: baseUnits });
    } else {
      await storage.upsertInventoryLevel({
        inventoryItemId,
        warehouseLocationId,
        onHandBase: 0,
        reservedBase: 0,
        pickedBase: 0,
        packedBase: 0,
        backorderBase: baseUnits,
      });
    }

    await this.logTransaction({
      inventoryItemId,
      warehouseLocationId,
      transactionType: "reserve",
      baseQtyDelta: baseUnits,
      sourceState: "backorder",
      targetState: "backorder",
      orderId,
      orderItemId,
      referenceType: "order",
      notes: "Backordered - insufficient stock",
      userId,
      isImplicit: 0,
    });

    console.log(`[Backorder] Recorded ${baseUnits} base units backorder for item ${inventoryItemId}`);
  }

  /**
   * Clear backorder when stock is received
   */
  async clearBackorder(
    inventoryItemId: number,
    warehouseLocationId: number,
    baseUnits: number,
    userId?: string
  ): Promise<void> {
    const levels = await storage.getInventoryLevelsByItemId(inventoryItemId);
    const levelAtLocation = levels.find(l => l.warehouseLocationId === warehouseLocationId);
    
    if (levelAtLocation && levelAtLocation.backorderBase > 0) {
      const toClear = Math.min(baseUnits, levelAtLocation.backorderBase);
      await storage.adjustInventoryLevel(levelAtLocation.id, { backorderBase: -toClear });
      
      console.log(`[Backorder] Cleared ${toClear} base units backorder for item ${inventoryItemId}`);
    }
  }

  /**
   * Get locations with low stock that need replenishment
   */
  async getLocationsNeedingReplenishment(inventoryItemId?: number): Promise<{
    locationId: number;
    locationCode: string;
    inventoryItemId: number;
    currentQty: number;
    minQty: number;
    parentLocationId: number | null;
  }[]> {
    const allLocations = await storage.getAllWarehouseLocations();
    const results: {
      locationId: number;
      locationCode: string;
      inventoryItemId: number;
      currentQty: number;
      minQty: number;
      parentLocationId: number | null;
    }[] = [];

    // Get locations with minQty set (these are the ones we track for replenishment)
    const locationsWithMinQty = allLocations.filter(l => l.minQty !== null && l.minQty > 0);

    for (const location of locationsWithMinQty) {
      // Get inventory levels at this location
      const allLevels = await storage.getAllInventoryLevels();
      const levelsAtLocation = allLevels.filter(l => l.warehouseLocationId === location.id);

      for (const level of levelsAtLocation) {
        if (inventoryItemId && level.inventoryItemId !== inventoryItemId) continue;
        
        if (level.onHandBase < (location.minQty || 0)) {
          results.push({
            locationId: location.id,
            locationCode: location.code,
            inventoryItemId: level.inventoryItemId,
            currentQty: level.onHandBase,
            minQty: location.minQty || 0,
            parentLocationId: location.parentLocationId,
          });
        }
      }
    }

    return results;
  }

  /**
   * Log an inventory transaction
   */
  private async logTransaction(transaction: InsertInventoryTransaction): Promise<InventoryTransaction> {
    return await storage.createInventoryTransaction(transaction);
  }
}

export const inventoryService = new InventoryService();
