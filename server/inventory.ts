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

    // Reserve is a state change only, not a physical movement - no variantQtyDelta
    await this.logTransaction({
      inventoryItemId,
      warehouseLocationId, // Legacy
      transactionType: "reserve",
      variantQtyDelta: 0, // No physical movement
      baseQtyDelta: baseUnits, // Legacy - tracks reservation amount
      sourceState: "on_hand",
      targetState: "committed", // Use "committed" not "reserved" per WMS spec
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

    // Unreserve is a state change only, not a physical movement
    await this.logTransaction({
      inventoryItemId,
      warehouseLocationId, // Legacy
      transactionType: "unreserve",
      variantQtyDelta: 0, // No physical movement
      baseQtyDelta: -baseUnits, // Legacy - tracks released amount
      sourceState: "committed", // Was "committed" (reserved)
      targetState: "on_hand", // Back to available
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

    // Log transaction with Full WMS fields
    const variantQtyBefore = levelAtLocation.variantQty || 0;
    const variantQtyAfter = Math.max(0, variantQtyBefore - baseUnits);
    
    // sourceState depends on whether we had a reservation (committed) or not (on_hand)
    const sourceState = reservedToRelease > 0 ? "committed" : "on_hand";
    
    await this.logTransaction({
      inventoryItemId,
      fromLocationId: warehouseLocationId, // Pick = FROM location
      warehouseLocationId, // Legacy compatibility
      transactionType: "pick",
      variantQtyDelta: -baseUnits,
      variantQtyBefore,
      variantQtyAfter,
      baseQtyDelta: -baseUnits,
      sourceState, // committed (was reserved) or on_hand (immediate pick)
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
    
    const variantQtyBefore = levelAtLocation?.variantQty || 0;
    
    if (levelAtLocation) {
      // Delta: subtract from picked (negative delta)
      await storage.adjustInventoryLevel(levelAtLocation.id, { pickedBase: -baseUnits });
    }

    await this.logTransaction({
      inventoryItemId,
      fromLocationId: warehouseLocationId, // Ship = FROM location (items leave)
      warehouseLocationId, // Legacy compatibility
      transactionType: "ship",
      variantQtyDelta: -baseUnits,
      variantQtyBefore,
      variantQtyAfter: Math.max(0, variantQtyBefore - baseUnits),
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

    const variantQtyBefore = levelAtLocation?.variantQty || 0;
    const variantQtyDelta = variantQty || baseUnits;
    
    await this.logTransaction({
      inventoryItemId,
      toLocationId: warehouseLocationId, // Receive = TO location
      warehouseLocationId, // Legacy compatibility
      variantId: variantId || undefined,
      transactionType: "receipt",
      variantQtyDelta,
      variantQtyBefore,
      variantQtyAfter: variantQtyBefore + variantQtyDelta,
      baseQtyDelta: baseUnits,
      sourceState: "external",
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
      // Delta adjustment in base units only
      // variantQty is managed separately based on actual variant count changes
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

    const variantQtyBefore = levelAtLocation?.variantQty || 0;
    const variantQtyAfter = Math.max(0, variantQtyBefore + baseUnitsDelta);
    
    await this.logTransaction({
      inventoryItemId,
      fromLocationId: baseUnitsDelta < 0 ? warehouseLocationId : undefined, // Negative = taking from
      toLocationId: baseUnitsDelta > 0 ? warehouseLocationId : undefined, // Positive = adding to
      warehouseLocationId, // Legacy compatibility
      transactionType: "adjustment",
      variantQtyDelta: baseUnitsDelta,
      variantQtyBefore,
      variantQtyAfter,
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

    // Log the replenishment transaction with Full WMS fields
    await this.logTransaction({
      inventoryItemId,
      fromLocationId: parentLocationId, // Source location
      toLocationId: targetLocationId, // Destination location
      warehouseLocationId: targetLocationId, // Legacy
      transactionType: "replenish",
      variantQtyDelta: replenishAmount,
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

    // Backorder is a demand-only record, no physical movement and no existing stock
    await this.logTransaction({
      inventoryItemId,
      warehouseLocationId, // Legacy
      transactionType: "reserve",
      variantQtyDelta: 0, // No physical movement - demand tracking only
      baseQtyDelta: baseUnits, // Legacy - tracks backorder demand
      sourceState: "external", // No stock exists - demand from external/future source
      targetState: "committed", // Committed demand (backordered)
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
   * Log an inventory transaction - public for use in routes.ts
   */
  async logTransaction(transaction: InsertInventoryTransaction): Promise<InventoryTransaction> {
    return await storage.createInventoryTransaction(transaction);
  }

  /**
   * Calculate cubic volume for a variant in mm³
   * Returns null if dimensions not set
   */
  getVariantCubicMm(variant: { widthMm: number | null; heightMm: number | null; depthMm: number | null }): number | null {
    if (variant.widthMm && variant.heightMm && variant.depthMm) {
      return variant.widthMm * variant.heightMm * variant.depthMm;
    }
    return null;
  }

  /**
   * Calculate total capacity of a location in mm³
   * Uses capacityCubicMm if set, otherwise calculates from dimensions
   */
  getLocationCapacityCubicMm(location: { 
    capacityCubicMm: number | null; 
    widthMm: number | null; 
    heightMm: number | null; 
    depthMm: number | null 
  }): number | null {
    if (location.capacityCubicMm) {
      return location.capacityCubicMm;
    }
    if (location.widthMm && location.heightMm && location.depthMm) {
      return location.widthMm * location.heightMm * location.depthMm;
    }
    return null;
  }

  /**
   * Calculate occupied cube at a location based on current inventory
   * Returns total cubic mm occupied by all variants at this location
   */
  async getLocationOccupiedCubicMm(
    locationId: number,
    inventoryLevels: InventoryLevel[],
    variantMap: Map<number, UomVariant>
  ): Promise<number> {
    let occupied = 0;
    
    for (const level of inventoryLevels) {
      if (level.warehouseLocationId !== locationId) continue;
      if (!level.variantId || level.variantQty <= 0) continue;
      
      const variant = variantMap.get(level.variantId);
      if (!variant) continue;
      
      const variantCube = this.getVariantCubicMm(variant);
      if (variantCube) {
        occupied += variantCube * level.variantQty;
      }
    }
    
    return occupied;
  }

  /**
   * Calculate remaining capacity at a location
   * Returns: { remainingCubicMm, maxUnits } or null if capacity not set
   */
  async calculateRemainingCapacity(
    location: { 
      id: number;
      capacityCubicMm: number | null; 
      widthMm: number | null; 
      heightMm: number | null; 
      depthMm: number | null 
    },
    variant: { widthMm: number | null; heightMm: number | null; depthMm: number | null },
    inventoryLevels: InventoryLevel[],
    variantMap: Map<number, UomVariant>
  ): Promise<{ remainingCubicMm: number; maxUnits: number } | null> {
    const locationCapacity = this.getLocationCapacityCubicMm(location);
    if (!locationCapacity) return null; // Capacity not enforced
    
    const variantCube = this.getVariantCubicMm(variant);
    if (!variantCube) return null; // Variant dimensions not set
    
    const occupied = await this.getLocationOccupiedCubicMm(location.id, inventoryLevels, variantMap);
    const remaining = Math.max(0, locationCapacity - occupied);
    const maxUnits = Math.floor(remaining / variantCube);
    
    return { remainingCubicMm: remaining, maxUnits };
  }

  /**
   * Find best overflow bin for excess inventory
   * Prioritizes: same warehouse > most available capacity
   * @param minUnitsRequired - If provided, only returns bins that can fit at least this many units
   */
  async findOverflowBin(
    warehouseId: number | null,
    variant: { widthMm: number | null; heightMm: number | null; depthMm: number | null },
    requiredUnits: number,
    inventoryLevels: InventoryLevel[],
    variantMap: Map<number, UomVariant>,
    allLocations: Array<{
      id: number;
      warehouseId: number | null;
      locationType: string;
      capacityCubicMm: number | null;
      widthMm: number | null;
      heightMm: number | null;
      depthMm: number | null;
    }>,
    minUnitsRequired?: number
  ): Promise<{ locationId: number; maxUnits: number } | null> {
    const variantCube = this.getVariantCubicMm(variant);
    if (!variantCube) return null;
    
    const overflowLocations = allLocations.filter(l => 
      l.locationType === "overflow" && 
      (warehouseId === null || l.warehouseId === warehouseId)
    );
    
    let bestBin: { locationId: number; maxUnits: number; remainingCube: number } | null = null;
    
    for (const loc of overflowLocations) {
      const capacity = await this.calculateRemainingCapacity(loc, variant, inventoryLevels, variantMap);
      if (!capacity || capacity.maxUnits <= 0) continue;
      
      // If minUnitsRequired is set, only consider bins that can fit that many
      if (minUnitsRequired && capacity.maxUnits < minUnitsRequired) continue;
      
      if (!bestBin || capacity.remainingCubicMm > bestBin.remainingCube) {
        bestBin = {
          locationId: loc.id,
          maxUnits: capacity.maxUnits,
          remainingCube: capacity.remainingCubicMm,
        };
      }
    }
    
    return bestBin ? { locationId: bestBin.locationId, maxUnits: bestBin.maxUnits } : null;
  }
}

export const inventoryService = new InventoryService();
