import { eq, and, sql, desc, isNull } from "drizzle-orm";
import {
  fulfillmentRoutingRules,
  warehouses,
  orders,
} from "@shared/schema";

type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface OrderRoutingContext {
  channelId: number | null;
  locationId?: string | null;   // Shopify fulfillment location_id (or future OMS location)
  skus?: string[];              // SKUs on the order (for sku_prefix matching)
  country?: string | null;      // Shipping country code
  tags?: string[];              // Order tags
}

export interface RoutingResult {
  warehouseId: number;
  warehouseCode: string;
  warehouseType: string;
  inventorySourceType: string;
  matchedRule: { id: number; matchType: string; matchValue: string | null } | null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Fulfillment routing engine.
 *
 * Determines which warehouse should fulfill an order based on configurable
 * rules. Rules are evaluated by priority (highest first), first match wins.
 *
 * OMS-agnostic: today rules match on Shopify location_id, but the matchType
 * system supports sku_prefix, country, tags, and default catch-all. When an
 * internal OMS replaces Shopify, just create rules with the new match types.
 */
class FulfillmentRouterService {
  constructor(private readonly db: DrizzleDb) {}

  /**
   * Route an order to a warehouse.
   *
   * Evaluates fulfillment_routing_rules by priority for the given channel.
   * Falls back to the default warehouse if no rule matches.
   */
  async routeOrder(ctx: OrderRoutingContext): Promise<RoutingResult | null> {
    // Fetch active rules for this channel (or global), ordered by priority DESC
    const rules = await this.db
      .select()
      .from(fulfillmentRoutingRules)
      .where(
        and(
          eq(fulfillmentRoutingRules.isActive, 1),
          // channelId IS NULL (global) OR matches this order's channel
          ctx.channelId
            ? sql`(${fulfillmentRoutingRules.channelId} IS NULL OR ${fulfillmentRoutingRules.channelId} = ${ctx.channelId})`
            : isNull(fulfillmentRoutingRules.channelId)
        )
      )
      .orderBy(desc(fulfillmentRoutingRules.priority), fulfillmentRoutingRules.id);

    for (const rule of rules) {
      if (this.matchesRule(rule, ctx)) {
        const warehouse = await this.getWarehouse(rule.warehouseId);
        if (!warehouse || warehouse.isActive !== 1) continue; // skip inactive warehouses
        return {
          warehouseId: warehouse.id,
          warehouseCode: warehouse.code,
          warehouseType: warehouse.warehouseType,
          inventorySourceType: warehouse.inventorySourceType,
          matchedRule: { id: rule.id, matchType: rule.matchType, matchValue: rule.matchValue },
        };
      }
    }

    // No rule matched — fall back to default warehouse
    return this.getDefaultWarehouseResult();
  }

  /**
   * Check if a routing rule matches the order context.
   */
  private matchesRule(rule: any, ctx: OrderRoutingContext): boolean {
    switch (rule.matchType) {
      case "location_id":
        return ctx.locationId != null && String(ctx.locationId) === String(rule.matchValue);

      case "sku_prefix":
        if (!ctx.skus?.length || !rule.matchValue) return false;
        return ctx.skus.some(sku => sku.toUpperCase().startsWith(rule.matchValue!.toUpperCase()));

      case "country":
        return ctx.country != null && ctx.country.toUpperCase() === rule.matchValue?.toUpperCase();

      case "tag":
        if (!ctx.tags?.length || !rule.matchValue) return false;
        return ctx.tags.some(t => t.toLowerCase() === rule.matchValue!.toLowerCase());

      case "default":
        return true; // always matches

      default:
        return false;
    }
  }

  /**
   * Get the default warehouse as a routing result (fallback when no rules match).
   */
  private async getDefaultWarehouseResult(): Promise<RoutingResult | null> {
    const [warehouse] = await this.db
      .select()
      .from(warehouses)
      .where(and(eq(warehouses.isDefault, 1), eq(warehouses.isActive, 1)))
      .limit(1);

    if (!warehouse) return null;

    return {
      warehouseId: warehouse.id,
      warehouseCode: warehouse.code,
      warehouseType: warehouse.warehouseType,
      inventorySourceType: warehouse.inventorySourceType,
      matchedRule: null,
    };
  }

  private async getWarehouse(id: number) {
    const [w] = await this.db.select().from(warehouses).where(eq(warehouses.id, id)).limit(1);
    return w;
  }

  /**
   * Assign a warehouse to an order and update its status accordingly.
   * For 3PL warehouses: sets status to 'awaiting_3pl'.
   * For operations warehouses: keeps existing status logic.
   */
  async assignWarehouseToOrder(orderId: number, routing: RoutingResult): Promise<void> {
    const updates: Record<string, any> = {
      warehouseId: routing.warehouseId,
      updatedAt: new Date(),
    };

    // 3PL orders get a different status — they don't enter the pick/pack workflow
    if (routing.warehouseType === "3pl") {
      updates.warehouseStatus = "awaiting_3pl";
    }

    await this.db
      .update(orders)
      .set(updates)
      .where(eq(orders.id, orderId));
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * ```ts
 * import { createFulfillmentRouterService } from "./fulfillment-router";
 *
 * const router = createFulfillmentRouterService(db);
 * const result = await router.routeOrder({ channelId: 1, locationId: "12345" });
 * ```
 */
export function createFulfillmentRouterService(db: any) {
  return new FulfillmentRouterService(db);
}
