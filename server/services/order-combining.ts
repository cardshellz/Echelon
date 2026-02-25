import { eq, inArray, sql, and } from "drizzle-orm";
import {
  orders,
  orderItems,
  combinedOrderGroups,
  appSettings,
} from "@shared/schema";
import type {
  CombinedOrderGroup,
  Order,
  OrderItem,
} from "@shared/schema";

// ---------------------------------------------------------------------------
// Type for the Drizzle `db` handle (matches other services)
// ---------------------------------------------------------------------------

type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
  execute: (...args: any[]) => any;
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CombinableGroup {
  addressHash: string;
  customerName: string;
  customerEmail: string | null;
  shippingAddress: string | null;
  shippingCity: string | null;
  shippingState: string | null;
  shippingPostalCode: string | null;
  shippingCountry: string | null;
  orders: {
    id: number;
    orderNumber: string;
    itemCount: number | null;
    unitCount: number | null;
    totalAmount: string | null;
    source: string | null;
    createdAt: string;
  }[];
  totalOrders: number;
  totalItems: number;
  totalUnits: number;
}

export interface CombineResult {
  group: CombinedOrderGroup;
  orders: { id: number; orderNumber: string; role: string }[];
}

export interface UncombineResult {
  dissolved: boolean;
  orderId: number;
  remainingCount?: number;
}

export interface GroupForShipping {
  group: CombinedOrderGroup;
  shippingAddress: {
    name: string;
    address: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    country: string | null;
  };
  orders: { id: number; orderNumber: string; role: string | null }[];
  items: {
    orderItemId: number;
    orderId: number;
    orderNumber: string;
    sku: string;
    name: string;
    quantity: number;
    pickedQuantity: number;
    location: string;
    imageUrl: string | null;
  }[];
  totalItems: number;
  totalUnits: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class OrderCombiningService {
  constructor(private db: DrizzleDb) {}

  // ---- Address normalization helpers ----

  private normalizeAddress(address: string | null | undefined): string {
    if (!address) return "";
    return address
      .toUpperCase()
      .replace(/[.,#\-]/g, "")
      .replace(/\s+/g, " ")
      .replace(/\bSTREET\b/g, "ST")
      .replace(/\bAVENUE\b/g, "AVE")
      .replace(/\bROAD\b/g, "RD")
      .replace(/\bDRIVE\b/g, "DR")
      .replace(/\bLANE\b/g, "LN")
      .replace(/\bBOULEVARD\b/g, "BLVD")
      .replace(/\bAPARTMENT\b/g, "APT")
      .replace(/\bSUITE\b/g, "STE")
      .trim();
  }

  private normalizePostalCode(postal: string | null | undefined): string {
    if (!postal) return "";
    return postal.replace(/[^0-9A-Za-z]/g, "").substring(0, 5).toUpperCase();
  }

  private createAddressHash(order: {
    shippingAddress?: string | null;
    shippingCity?: string | null;
    shippingState?: string | null;
    shippingPostalCode?: string | null;
    customerEmail?: string | null;
    shipping_address?: string | null;
    shipping_city?: string | null;
    shipping_state?: string | null;
    shipping_postal_code?: string | null;
    customer_email?: string | null;
  }): string {
    const email = (order.customerEmail || order.customer_email || "").toLowerCase().trim();
    const normalized = [
      this.normalizeAddress(order.shippingAddress || order.shipping_address),
      this.normalizeAddress(order.shippingCity || order.shipping_city),
      this.normalizeAddress(order.shippingState || order.shipping_state),
      this.normalizePostalCode(order.shippingPostalCode || order.shipping_postal_code),
      email
    ].join("|");
    return normalized;
  }

  // ---- Settings ----

  async getSettings(): Promise<{ enabled: boolean }> {
    const setting = await this.db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, "enable_order_combining"))
      .limit(1);
    const enabled = setting.length > 0 ? setting[0].value === "true" : true;
    return { enabled };
  }

  async updateSettings(enabled: boolean): Promise<{ enabled: boolean }> {
    await this.db
      .update(appSettings)
      .set({ value: enabled ? "true" : "false", updatedAt: new Date() })
      .where(eq(appSettings.key, "enable_order_combining"));
    return { enabled };
  }

  // ---- Combinable groups ----

  async getCombinableGroups(): Promise<CombinableGroup[]> {
    // Compute shippable item/unit counts from order_items (same logic as pick queue)
    // items = distinct shippable line items, units = sum of shippable quantities
    let result;
    try {
      // LEFT JOIN combined_order_groups to only show "combined" badge when the group actually exists
      // (prevents orphaned combined_group_id from showing false badges)
      result = await this.db.execute(sql`
        SELECT o.id, o.order_number, o.customer_name, o.customer_email,
               o.shipping_address, o.shipping_city, o.shipping_state,
               o.shipping_postal_code, o.shipping_country,
               o.total_amount, o.source, o.created_at,
               CASE WHEN cog.id IS NOT NULL THEN o.combined_group_id ELSE NULL END AS combined_group_id,
               CASE WHEN cog.id IS NOT NULL THEN o.combined_role ELSE NULL END AS combined_role,
               COALESCE((SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id AND oi.requires_shipping = 1), 0) AS shippable_items,
               COALESCE((SELECT SUM(oi.quantity) FROM order_items oi WHERE oi.order_id = o.id AND oi.requires_shipping = 1), 0) AS shippable_units
        FROM orders o
        LEFT JOIN combined_order_groups cog ON cog.id = o.combined_group_id AND cog.status != 'cancelled'
        LEFT JOIN shopify_orders s ON o.source_table_id = s.id
        WHERE o.warehouse_status = 'ready'
          AND o.on_hold = 0
          AND (s.cancelled_at IS NULL OR s.id IS NULL)
      `);
    } catch (columnError: any) {
      if (columnError?.code === "42703") {
        console.log("Note: combined_group_id column not yet in database, querying without it");
        result = await this.db.execute(sql`
          SELECT o.id, o.order_number, o.customer_name, o.customer_email,
                 o.shipping_address, o.shipping_city, o.shipping_state,
                 o.shipping_postal_code, o.shipping_country,
                 o.total_amount, o.source, o.created_at,
                 COALESCE((SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id AND oi.requires_shipping = 1), 0) AS shippable_items,
                 COALESCE((SELECT SUM(oi.quantity) FROM order_items oi WHERE oi.order_id = o.id AND oi.requires_shipping = 1), 0) AS shippable_units
          FROM orders o
          LEFT JOIN shopify_orders s ON o.source_table_id = s.id
          WHERE o.warehouse_status = 'ready'
            AND o.on_hold = 0
            AND (s.cancelled_at IS NULL OR s.id IS NULL)
        `);
      } else {
        throw columnError;
      }
    }

    const readyOrders = result.rows as any[];
    const groupedByAddress = new Map<string, typeof readyOrders>();

    for (const order of readyOrders) {
      const hash = this.createAddressHash(order);
      if (!hash || hash === "||||" || !hash.replace(/\|/g, "").trim()) continue;
      if (!groupedByAddress.has(hash)) {
        groupedByAddress.set(hash, []);
      }
      groupedByAddress.get(hash)!.push(order);
    }

    return Array.from(groupedByAddress.entries())
      .filter(([_, grpOrders]) => {
        // Need 2+ orders AND at least one uncombined order (otherwise group is already complete)
        if (grpOrders.length < 2) return false;
        return grpOrders.some((o: any) => !o.combined_group_id);
      })
      .map(([hash, grpOrders]) => {
        const first = grpOrders[0];
        return {
          addressHash: hash,
          customerName: first.customer_name,
          customerEmail: first.customer_email,
          shippingAddress: first.shipping_address,
          shippingCity: first.shipping_city,
          shippingState: first.shipping_state,
          shippingPostalCode: first.shipping_postal_code,
          shippingCountry: first.shipping_country,
          orders: grpOrders.map((o: any) => ({
            id: o.id,
            orderNumber: o.order_number,
            itemCount: Number(o.shippable_items) || 0,
            unitCount: Number(o.shippable_units) || 0,
            totalAmount: o.total_amount,
            source: o.source,
            createdAt: o.created_at,
            combinedGroupId: o.combined_group_id ?? null,
            combinedRole: o.combined_role ?? null,
          })),
          totalOrders: grpOrders.length,
          totalItems: grpOrders.reduce((sum: number, o: any) => sum + (Number(o.shippable_items) || 0), 0),
          totalUnits: grpOrders.reduce((sum: number, o: any) => sum + (Number(o.shippable_units) || 0), 0),
        };
      })
      .sort((a, b) => b.totalOrders - a.totalOrders);
  }

  // ---- Combine orders ----

  async combineOrders(orderIds: number[], createdBy: string): Promise<CombineResult> {
    if (!orderIds || !Array.isArray(orderIds) || orderIds.length < 1) {
      throw new CombineError("At least 1 order ID required", 400);
    }

    const ordersToGroup: Order[] = await this.db
      .select()
      .from(orders)
      .where(inArray(orders.id, orderIds));

    if (ordersToGroup.length !== orderIds.length) {
      throw new CombineError("Some orders not found", 400);
    }

    for (const order of ordersToGroup) {
      if (order.warehouseStatus !== "ready") {
        throw new CombineError(`Order ${order.orderNumber} is not in ready status`, 400);
      }
      if (order.onHold) {
        throw new CombineError(`Order ${order.orderNumber} is on hold`, 400);
      }
    }

    // Determine existing group IDs among selected orders
    const existingGroupIds = new Set<number>();
    for (const order of ordersToGroup) {
      if (order.combinedGroupId) existingGroupIds.add(order.combinedGroupId);
    }
    const newOrders = ordersToGroup.filter((o) => !o.combinedGroupId);

    // --- Add-to-group: all combined orders belong to one group, just add new ones ---
    if (existingGroupIds.size === 1 && newOrders.length > 0) {
      const groupId = Array.from(existingGroupIds)[0];
      const existingGroup: CombinedOrderGroup[] = await this.db
        .select()
        .from(combinedOrderGroups)
        .where(eq(combinedOrderGroups.id, groupId))
        .limit(1);

      if (!existingGroup.length) {
        throw new CombineError("Existing combined group not found", 400);
      }

      // Add new orders as children
      for (const order of newOrders) {
        await this.db
          .update(orders)
          .set({ combinedGroupId: groupId, combinedRole: "child" })
          .where(eq(orders.id, order.id));
      }

      // Recalculate group counts from all member orders
      const allGroupOrders: Order[] = await this.db
        .select()
        .from(orders)
        .where(eq(orders.combinedGroupId, groupId));

      await this.db
        .update(combinedOrderGroups)
        .set({
          orderCount: allGroupOrders.length,
          totalItems: allGroupOrders.reduce((sum, o) => sum + (o.itemCount || 0), 0),
          totalUnits: allGroupOrders.reduce((sum, o) => sum + (o.unitCount || 0), 0),
          updatedAt: new Date(),
        })
        .where(eq(combinedOrderGroups.id, groupId));

      const updatedGroup: CombinedOrderGroup[] = await this.db
        .select()
        .from(combinedOrderGroups)
        .where(eq(combinedOrderGroups.id, groupId))
        .limit(1);

      return {
        group: updatedGroup[0],
        orders: allGroupOrders.map((o) => ({
          id: o.id,
          orderNumber: o.orderNumber,
          role: o.combinedRole || "child",
        })),
      };
    }

    // --- Merge: orders from multiple existing groups → dissolve old, create new ---
    if (existingGroupIds.size > 1) {
      // Dissolve all old groups
      for (const gid of Array.from(existingGroupIds)) {
        await this.db
          .update(orders)
          .set({ combinedGroupId: null, combinedRole: null })
          .where(eq(orders.combinedGroupId, gid));
        await this.db
          .delete(combinedOrderGroups)
          .where(eq(combinedOrderGroups.id, gid));
      }
      // Clear in-memory state so they all get the new group
      for (const order of ordersToGroup) {
        (order as any).combinedGroupId = null;
        (order as any).combinedRole = null;
      }
    }

    // --- Create new group (no existing groups, or post-merge) ---
    if (existingGroupIds.size === 0 || existingGroupIds.size > 1) {
      if (ordersToGroup.length < 2) {
        throw new CombineError("At least 2 orders required to create a new group", 400);
      }
    }

    // Earliest order becomes the parent
    ordersToGroup.sort((a, b) => {
      const dateA = new Date(a.orderPlacedAt || a.shopifyCreatedAt || a.createdAt || 0).getTime();
      const dateB = new Date(b.orderPlacedAt || b.shopifyCreatedAt || b.createdAt || 0).getTime();
      return dateA - dateB;
    });

    const parentOrder = ordersToGroup[0];
    let groupCode = `G-${parentOrder.orderNumber.replace("#", "")}`;

    // Clean up stale group with same code if no orders reference it
    const staleGroup = await this.db
      .select()
      .from(combinedOrderGroups)
      .where(eq(combinedOrderGroups.groupCode, groupCode))
      .limit(1);
    if (staleGroup.length > 0) {
      const refs = await this.db
        .select({ id: orders.id })
        .from(orders)
        .where(eq(orders.combinedGroupId, staleGroup[0].id))
        .limit(1);
      if (refs.length === 0) {
        await this.db
          .delete(combinedOrderGroups)
          .where(eq(combinedOrderGroups.id, staleGroup[0].id));
      } else {
        // Group is still referenced — use a unique suffix
        groupCode = `G-${parentOrder.orderNumber.replace("#", "")}-${Date.now().toString(36)}`;
      }
    }

    const [group] = await this.db
      .insert(combinedOrderGroups)
      .values({
        groupCode,
        customerName: parentOrder.customerName,
        customerEmail: parentOrder.customerEmail,
        shippingAddress: parentOrder.shippingAddress,
        shippingCity: parentOrder.shippingCity,
        shippingState: parentOrder.shippingState,
        shippingPostalCode: parentOrder.shippingPostalCode,
        shippingCountry: parentOrder.shippingCountry,
        addressHash: this.createAddressHash(parentOrder),
        orderCount: ordersToGroup.length,
        totalItems: ordersToGroup.reduce((sum, o) => sum + (o.itemCount || 0), 0),
        totalUnits: ordersToGroup.reduce((sum, o) => sum + (o.unitCount || 0), 0),
        createdBy,
      })
      .returning();

    for (let i = 0; i < ordersToGroup.length; i++) {
      await this.db
        .update(orders)
        .set({
          combinedGroupId: group.id,
          combinedRole: i === 0 ? "parent" : "child",
        })
        .where(eq(orders.id, ordersToGroup[i].id));
    }

    return {
      group,
      orders: ordersToGroup.map((o, i) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        role: i === 0 ? "parent" : "child",
      })),
    };
  }

  // ---- Combine all ----

  async combineAll(createdBy: string): Promise<{ groupsCreated: number; totalOrdersCombined: number }> {
    let result;
    try {
      // LEFT JOIN to validate combined_group_id references an existing active group
      result = await this.db.execute(sql`
        SELECT o.id, o.order_number, o.customer_name, o.customer_email,
               o.shipping_address, o.shipping_city, o.shipping_state,
               o.shipping_postal_code, o.shipping_country, o.item_count,
               o.unit_count, o.total_amount, o.source, o.created_at,
               o.order_placed_at, o.shopify_created_at,
               CASE WHEN cog.id IS NOT NULL THEN o.combined_group_id ELSE NULL END AS combined_group_id
        FROM orders o
        LEFT JOIN combined_order_groups cog ON cog.id = o.combined_group_id AND cog.status != 'cancelled'
        WHERE o.warehouse_status = 'ready'
          AND o.on_hold = 0
      `);
    } catch {
      throw new CombineError("Failed to query orders", 500);
    }

    const readyOrders = result.rows as any[];
    const groupedByAddress = new Map<string, any[]>();

    for (const order of readyOrders) {
      const hash = this.createAddressHash(order);
      if (!hash || hash === "||||" || !hash.replace(/\|/g, "").trim()) continue;
      if (!groupedByAddress.has(hash)) {
        groupedByAddress.set(hash, []);
      }
      groupedByAddress.get(hash)!.push(order);
    }

    // Only groups with 2+ orders AND at least one uncombined
    const combinableGroups = Array.from(groupedByAddress.entries())
      .filter(([_, grpOrders]) => {
        if (grpOrders.length < 2) return false;
        return grpOrders.some((o: any) => !o.combined_group_id);
      });

    if (combinableGroups.length === 0) {
      return { groupsCreated: 0, totalOrdersCombined: 0 };
    }

    let groupsCreated = 0;
    let totalOrdersCombined = 0;

    for (const [_, grpOrders] of combinableGroups) {
      // Dissolve any existing groups these orders belong to
      const existingGroupIds = new Set<number>();
      for (const o of grpOrders) {
        if (o.combined_group_id) existingGroupIds.add(o.combined_group_id);
      }
      for (const gid of Array.from(existingGroupIds)) {
        await this.db
          .update(orders)
          .set({ combinedGroupId: null, combinedRole: null })
          .where(eq(orders.combinedGroupId, gid));
        await this.db
          .delete(combinedOrderGroups)
          .where(eq(combinedOrderGroups.id, gid));
      }

      // Sort by order date ascending — earliest becomes parent
      grpOrders.sort((a: any, b: any) => {
        const dateA = new Date(a.order_placed_at || a.shopify_created_at || a.created_at || 0).getTime();
        const dateB = new Date(b.order_placed_at || b.shopify_created_at || b.created_at || 0).getTime();
        return dateA - dateB;
      });
      const parentOrder = grpOrders[0];
      let groupCode = `G-${(parentOrder.order_number || "").replace("#", "")}`;

      // Clean up stale group with same code if no orders reference it
      const staleGroup = await this.db
        .select()
        .from(combinedOrderGroups)
        .where(eq(combinedOrderGroups.groupCode, groupCode))
        .limit(1);
      if (staleGroup.length > 0) {
        const refs = await this.db
          .select({ id: orders.id })
          .from(orders)
          .where(eq(orders.combinedGroupId, staleGroup[0].id))
          .limit(1);
        if (refs.length === 0) {
          await this.db
            .delete(combinedOrderGroups)
            .where(eq(combinedOrderGroups.id, staleGroup[0].id));
        } else {
          groupCode = `G-${(parentOrder.order_number || "").replace("#", "")}-${Date.now().toString(36)}`;
        }
      }

      const [group] = await this.db
        .insert(combinedOrderGroups)
        .values({
          groupCode,
          customerName: parentOrder.customer_name,
          customerEmail: parentOrder.customer_email,
          shippingAddress: parentOrder.shipping_address,
          shippingCity: parentOrder.shipping_city,
          shippingState: parentOrder.shipping_state,
          shippingPostalCode: parentOrder.shipping_postal_code,
          shippingCountry: parentOrder.shipping_country,
          addressHash: this.createAddressHash(parentOrder),
          orderCount: grpOrders.length,
          totalItems: grpOrders.reduce((sum: number, o: any) => sum + (o.item_count || 0), 0),
          totalUnits: grpOrders.reduce((sum: number, o: any) => sum + (o.unit_count || 0), 0),
          createdBy,
        })
        .returning();

      for (let i = 0; i < grpOrders.length; i++) {
        await this.db
          .update(orders)
          .set({
            combinedGroupId: group.id,
            combinedRole: i === 0 ? "parent" : "child",
          })
          .where(eq(orders.id, grpOrders[i].id));
      }

      groupsCreated++;
      totalOrdersCombined += grpOrders.length;
    }

    return { groupsCreated, totalOrdersCombined };
  }

  // ---- Uncombine ----

  async uncombineOrder(orderId: number): Promise<UncombineResult> {
    const orderResult: Order[] = await this.db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    if (!orderResult.length) {
      throw new CombineError("Order not found", 404);
    }

    if (!orderResult[0].combinedGroupId) {
      throw new CombineError("Order is not in a combined group", 400);
    }

    const groupId = orderResult[0].combinedGroupId;
    const removedRole = orderResult[0].combinedRole;

    // Remove order from group
    await this.db
      .update(orders)
      .set({ combinedGroupId: null, combinedRole: null })
      .where(eq(orders.id, orderId));

    // Check remaining
    const remaining: Order[] = await this.db
      .select()
      .from(orders)
      .where(eq(orders.combinedGroupId, groupId));

    if (remaining.length < 2) {
      // Dissolve the group
      for (const o of remaining) {
        await this.db
          .update(orders)
          .set({ combinedGroupId: null, combinedRole: null })
          .where(eq(orders.id, o.id));
      }
      await this.db
        .delete(combinedOrderGroups)
        .where(eq(combinedOrderGroups.id, groupId));
      return { dissolved: true, orderId };
    }

    // Update group counts
    await this.db
      .update(combinedOrderGroups)
      .set({
        orderCount: remaining.length,
        totalItems: remaining.reduce((sum, o) => sum + (o.itemCount || 0), 0),
        totalUnits: remaining.reduce((sum, o) => sum + (o.unitCount || 0), 0),
        updatedAt: new Date(),
      })
      .where(eq(combinedOrderGroups.id, groupId));

    // If the parent was removed, promote first remaining
    if (removedRole === "parent") {
      await this.db
        .update(orders)
        .set({ combinedRole: "parent" })
        .where(eq(orders.id, remaining[0].id));
    }

    return { dissolved: false, orderId, remainingCount: remaining.length };
  }

  // ---- Active groups ----

  async getActiveGroups() {
    const groups = await this.db
      .select()
      .from(combinedOrderGroups)
      .where(eq(combinedOrderGroups.status, "active"));

    const groupsWithOrders = await Promise.all(
      groups.map(async (group: CombinedOrderGroup) => {
        const groupOrders = await this.db
          .select()
          .from(orders)
          .where(eq(orders.combinedGroupId, group.id));
        return {
          ...group,
          orders: groupOrders.map((o: Order) => ({
            id: o.id,
            orderNumber: o.orderNumber,
            role: o.combinedRole,
            status: o.warehouseStatus,
            itemCount: o.itemCount,
            unitCount: o.unitCount,
          })),
        };
      })
    );

    return groupsWithOrders;
  }

  // ---- Shipping-engine-ready methods ----

  async getGroupForShipping(groupId: number): Promise<GroupForShipping> {
    const groupResult = await this.db
      .select()
      .from(combinedOrderGroups)
      .where(eq(combinedOrderGroups.id, groupId))
      .limit(1);

    if (!groupResult.length) {
      throw new CombineError("Combined group not found", 404);
    }

    const group = groupResult[0] as CombinedOrderGroup;

    const groupOrders = await this.db
      .select()
      .from(orders)
      .where(eq(orders.combinedGroupId, groupId));

    if (!groupOrders.length) {
      throw new CombineError("No orders found in group", 400);
    }

    // Get all items across all orders in the group
    const orderIdList = groupOrders.map((o: Order) => o.id);
    const items = await this.db
      .select()
      .from(orderItems)
      .where(inArray(orderItems.orderId, orderIdList));

    // Build order number lookup for items
    const orderNumberMap = new Map<number, string>();
    for (const o of groupOrders) {
      orderNumberMap.set(o.id, o.orderNumber);
    }

    return {
      group,
      shippingAddress: {
        name: group.customerName,
        address: group.shippingAddress,
        city: group.shippingCity,
        state: group.shippingState,
        postalCode: group.shippingPostalCode,
        country: group.shippingCountry,
      },
      orders: groupOrders.map((o: Order) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        role: o.combinedRole,
      })),
      items: items.map((item: OrderItem) => ({
        orderItemId: item.id,
        orderId: item.orderId,
        orderNumber: orderNumberMap.get(item.orderId) || "",
        sku: item.sku,
        name: item.name,
        quantity: item.quantity,
        pickedQuantity: item.pickedQuantity,
        location: item.location,
        imageUrl: item.imageUrl,
      })),
      totalItems: items.length,
      totalUnits: items.reduce((sum: number, item: OrderItem) => sum + item.quantity, 0),
    };
  }

  async markGroupPacked(groupId: number, packedBy: string): Promise<void> {
    const groupResult = await this.db
      .select()
      .from(combinedOrderGroups)
      .where(eq(combinedOrderGroups.id, groupId))
      .limit(1);

    if (!groupResult.length) {
      throw new CombineError("Combined group not found", 404);
    }

    await this.db
      .update(combinedOrderGroups)
      .set({ status: "packed", updatedAt: new Date() })
      .where(eq(combinedOrderGroups.id, groupId));

    await this.db
      .update(orders)
      .set({ warehouseStatus: "packed" })
      .where(eq(orders.combinedGroupId, groupId));
  }

  async markGroupShipped(
    groupId: number,
    trackingNumber: string,
    carrier?: string
  ): Promise<void> {
    const groupResult = await this.db
      .select()
      .from(combinedOrderGroups)
      .where(eq(combinedOrderGroups.id, groupId))
      .limit(1);

    if (!groupResult.length) {
      throw new CombineError("Combined group not found", 404);
    }

    await this.db
      .update(combinedOrderGroups)
      .set({ status: "shipped", updatedAt: new Date() })
      .where(eq(combinedOrderGroups.id, groupId));

    await this.db
      .update(orders)
      .set({ warehouseStatus: "shipped" })
      .where(eq(orders.combinedGroupId, groupId));
  }
}

// ---------------------------------------------------------------------------
// Error type for route-layer status code handling
// ---------------------------------------------------------------------------

export class CombineError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = "CombineError";
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOrderCombiningService(db: DrizzleDb) {
  return new OrderCombiningService(db);
}

export type { OrderCombiningService };
