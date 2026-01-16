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
    const onHand = await storage.getTotalOnHandByItemId(inventoryItemId, true);
    const reserved = await storage.getTotalReservedByItemId(inventoryItemId);
    return onHand - reserved;
  }

  /**
   * Calculate available quantity for each UOM variant based on base ATP
   * Returns floor(ATP / units_per_variant) for each variant
   */
  async calculateVariantAvailability(inventoryItemId: number): Promise<VariantAvailability[]> {
    const variants = await storage.getUomVariantsByInventoryItemId(inventoryItemId);
    const atp = await this.calculateATP(inventoryItemId);
    const onHand = await storage.getTotalOnHandByItemId(inventoryItemId, true);
    const reserved = await storage.getTotalReservedByItemId(inventoryItemId);
    
    return variants.map(variant => ({
      variantId: variant.id,
      sku: variant.sku,
      name: variant.name,
      unitsPerVariant: variant.unitsPerVariant,
      available: Math.floor(atp / variant.unitsPerVariant),
      onHandBase: onHand,
      reservedBase: reserved,
      atpBase: atp,
    }));
  }

  /**
   * Get full inventory summary for an item including all variant availability
   */
  async getInventoryItemSummary(inventoryItemId: number): Promise<InventoryItemSummary | null> {
    const items = await storage.getAllInventoryItems();
    const item = items.find(i => i.id === inventoryItemId);
    if (!item) return null;

    const variants = await this.calculateVariantAvailability(inventoryItemId);
    const onHand = await storage.getTotalOnHandByItemId(inventoryItemId, true);
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
    userId?: string
  ): Promise<void> {
    const existing = await storage.getInventoryLevelsByItemId(inventoryItemId);
    const levelAtLocation = existing.find(l => l.warehouseLocationId === warehouseLocationId);
    
    if (levelAtLocation) {
      // Delta: add to onHand (positive delta)
      await storage.adjustInventoryLevel(levelAtLocation.id, { onHandBase: baseUnits });
    } else {
      await storage.upsertInventoryLevel({
        inventoryItemId,
        warehouseLocationId,
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
   * Log an inventory transaction
   */
  private async logTransaction(transaction: InsertInventoryTransaction): Promise<InventoryTransaction> {
    return await storage.createInventoryTransaction(transaction);
  }
}

export const inventoryService = new InventoryService();
