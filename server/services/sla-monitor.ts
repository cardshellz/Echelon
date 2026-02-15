import { eq, and, sql, isNull, inArray } from "drizzle-orm";
import {
  orders,
  channels,
  partnerProfiles,
  warehouses,
} from "@shared/schema";

type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
  execute: <T = any>(query: any) => Promise<{ rows: T[] }>;
};

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface SLAAlert {
  orderId: number;
  orderNumber: string;
  channelName: string | null;
  warehouseCode: string | null;
  warehouseType: string | null;
  slaDueAt: Date;
  slaStatus: string;
  orderPlacedAt: Date | null;
  hoursRemaining: number;
}

export interface SLASummary {
  onTime: number;
  atRisk: number;
  overdue: number;
  met: number;
  total: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * SLA monitoring service.
 *
 * Tracks fulfillment SLA compliance for orders, especially 3PL orders
 * where the fulfillment timeline is less visible.
 *
 * SLA statuses:
 *   - on_time:  order is within SLA window, more than 24h remaining
 *   - at_risk:  within 24h of SLA due date
 *   - overdue:  past SLA due date, not yet shipped
 *   - met:      shipped before SLA due date
 *
 * `slaDueAt` is computed as: orderPlacedAt + partnerProfile.slaDays (business days)
 * If no partner profile exists, uses a default of 3 business days.
 */
class SLAMonitorService {
  private readonly DEFAULT_SLA_DAYS = 3;

  constructor(private readonly db: DrizzleDb) {}

  /**
   * Set SLA due date on an order based on its channel's partner profile.
   * Called when an order is routed to a warehouse.
   */
  async setSLAForOrder(orderId: number): Promise<void> {
    const [order] = await this.db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    if (!order) return;

    // Only set SLA for orders that don't already have one
    if (order.slaDueAt) return;

    // Get SLA days from partner profile (if channel has one)
    let slaDays = this.DEFAULT_SLA_DAYS;
    if (order.channelId) {
      const [profile] = await this.db
        .select()
        .from(partnerProfiles)
        .where(eq(partnerProfiles.channelId, order.channelId))
        .limit(1);

      if (profile?.slaDays) {
        slaDays = profile.slaDays;
      }
    }

    const placedAt = order.orderPlacedAt || order.createdAt;
    const dueAt = this.addBusinessDays(new Date(placedAt), slaDays);

    await this.db
      .update(orders)
      .set({
        slaDueAt: dueAt,
        slaStatus: "on_time",
      })
      .where(eq(orders.id, orderId));
  }

  /**
   * Update SLA statuses for all active orders.
   * Should be called periodically (e.g., every 15 minutes).
   */
  async updateSLAStatuses(): Promise<{ updated: number }> {
    const now = new Date();
    const twentyFourHoursFromNow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    let updated = 0;

    // 1. Mark shipped/completed orders as "met" if they were shipped before SLA due
    const metResult = await this.db.execute(sql`
      UPDATE orders SET sla_status = 'met'
      WHERE sla_due_at IS NOT NULL
        AND sla_status NOT IN ('met')
        AND warehouse_status IN ('shipped', 'completed')
        AND (completed_at IS NULL OR completed_at <= sla_due_at)
    `);

    // 2. Mark shipped orders as "overdue" if they shipped after SLA due
    await this.db.execute(sql`
      UPDATE orders SET sla_status = 'overdue'
      WHERE sla_due_at IS NOT NULL
        AND sla_status NOT IN ('met', 'overdue')
        AND warehouse_status IN ('shipped', 'completed')
        AND completed_at > sla_due_at
    `);

    // 3. Mark active (non-terminal) orders past due as "overdue"
    await this.db.execute(sql`
      UPDATE orders SET sla_status = 'overdue'
      WHERE sla_due_at IS NOT NULL
        AND sla_status NOT IN ('met', 'overdue')
        AND warehouse_status NOT IN ('shipped', 'completed', 'cancelled')
        AND sla_due_at < ${now}
    `);

    // 4. Mark active orders within 24h of due as "at_risk"
    await this.db.execute(sql`
      UPDATE orders SET sla_status = 'at_risk'
      WHERE sla_due_at IS NOT NULL
        AND sla_status NOT IN ('met', 'overdue', 'at_risk')
        AND warehouse_status NOT IN ('shipped', 'completed', 'cancelled')
        AND sla_due_at >= ${now}
        AND sla_due_at < ${twentyFourHoursFromNow}
    `);

    // 5. Mark remaining active orders as "on_time"
    await this.db.execute(sql`
      UPDATE orders SET sla_status = 'on_time'
      WHERE sla_due_at IS NOT NULL
        AND sla_status IS DISTINCT FROM 'on_time'
        AND warehouse_status NOT IN ('shipped', 'completed', 'cancelled')
        AND sla_due_at >= ${twentyFourHoursFromNow}
    `);

    return { updated };
  }

  /**
   * Get SLA alerts for active orders (at_risk + overdue).
   */
  async getSLAAlerts(): Promise<SLAAlert[]> {
    const now = new Date();

    const result = await this.db.execute<{
      id: number;
      order_number: string;
      channel_name: string | null;
      warehouse_code: string | null;
      warehouse_type: string | null;
      sla_due_at: Date;
      sla_status: string;
      order_placed_at: Date | null;
    }>(sql`
      SELECT
        o.id,
        o.order_number,
        c.name as channel_name,
        w.code as warehouse_code,
        w.warehouse_type,
        o.sla_due_at,
        o.sla_status,
        o.order_placed_at
      FROM orders o
      LEFT JOIN channels c ON o.channel_id = c.id
      LEFT JOIN warehouses w ON o.warehouse_id = w.id
      WHERE o.sla_due_at IS NOT NULL
        AND o.sla_status IN ('at_risk', 'overdue')
        AND o.warehouse_status NOT IN ('shipped', 'completed', 'cancelled')
      ORDER BY o.sla_due_at ASC
    `);

    return result.rows.map(row => ({
      orderId: row.id,
      orderNumber: row.order_number,
      channelName: row.channel_name,
      warehouseCode: row.warehouse_code,
      warehouseType: row.warehouse_type,
      slaDueAt: new Date(row.sla_due_at),
      slaStatus: row.sla_status,
      orderPlacedAt: row.order_placed_at ? new Date(row.order_placed_at) : null,
      hoursRemaining: Math.round(
        (new Date(row.sla_due_at).getTime() - now.getTime()) / (1000 * 60 * 60)
      ),
    }));
  }

  /**
   * Get SLA summary counts for dashboard.
   */
  async getSLASummary(): Promise<SLASummary> {
    const result = await this.db.execute<{
      sla_status: string;
      count: string;
    }>(sql`
      SELECT sla_status, COUNT(*)::text as count
      FROM orders
      WHERE sla_due_at IS NOT NULL
        AND warehouse_status NOT IN ('cancelled')
      GROUP BY sla_status
    `);

    const counts: Record<string, number> = {};
    for (const row of result.rows) {
      counts[row.sla_status] = parseInt(row.count, 10);
    }

    return {
      onTime: counts["on_time"] || 0,
      atRisk: counts["at_risk"] || 0,
      overdue: counts["overdue"] || 0,
      met: counts["met"] || 0,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
    };
  }

  /**
   * Add business days (Mon-Fri) to a date.
   */
  private addBusinessDays(date: Date, days: number): Date {
    const result = new Date(date);
    let added = 0;
    while (added < days) {
      result.setDate(result.getDate() + 1);
      const dow = result.getDay();
      if (dow !== 0 && dow !== 6) {
        added++;
      }
    }
    // Set to end of business day (5 PM)
    result.setHours(17, 0, 0, 0);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSLAMonitorService(db: any) {
  return new SLAMonitorService(db);
}
