// pick-priority.routes.ts
//
// Admin API for the consolidated Pick Priority settings page. Owns three
// inputs that feed into the pick queue's composite sort_rank:
//
//   1. Shipping service-level base scores (standard / expedited / overnight)
//      \u2014 stored in warehouse.echelon_settings under keys
//        priority.shipping_base.{standard,expedited,overnight}
//   2. Default SLA fallback (business days) \u2014 warehouse.echelon_settings
//        priority.sla_default_days
//   3. Plan priority modifiers \u2014 membership.plans.priority_modifier per plan
//
// The settings rows are seeded by migration 0559; this endpoint only updates
// them. Plans are updated via raw UPDATE on membership.plans because the
// plans.id column is varchar and primary_color lives in the DB but not in
// the Drizzle schema.

import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { requireAuth, requirePermission } from "./middleware";
import { invalidatePickPrioritySettingsCache } from "../modules/orders/sort-rank";
import { recomputeAllActiveSortRanksDetailed } from "../modules/orders/orders.storage";
import { enqueueShipStationSortRankSyncRetry } from "../modules/oms/webhook-retry.worker";

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

type ShippingLevel = "standard" | "expedited" | "overnight";

interface PickPriorityPayload {
  shippingBase: Record<ShippingLevel, number>;
  slaDefaultDays: number;
  plans: Array<{
    id: string;
    name: string;
    tierLevel: number | null;
    priorityModifier: number;
    primaryColor: string | null;
    isActive: boolean;
  }>;
  channels: Array<{
    id: number;
    name: string;
    provider: string;
    status: string;
    // null = inherit the global slaDefaultDays fallback
    slaDays: number | null;
  }>;
}

interface PickPriorityUpdate {
  shippingBase?: Partial<Record<ShippingLevel, number>>;
  slaDefaultDays?: number;
  planModifiers?: Record<string, number>;
  // channelId -> SLA business days, or null to clear (inherit global default)
  channelSlaDays?: Record<string, number | null>;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const SHIPPING_MIN = 0;
const SHIPPING_MAX = 9999;
const SLA_MIN = 0;
const SLA_MAX = 30;
const PLAN_MOD_MIN = 0;
const PLAN_MOD_MAX = 500;
// Per-channel SLA shares the same 0–30 business-day bound as the global default.
const CHANNEL_SLA_MIN = 0;
const CHANNEL_SLA_MAX = 30;

function validateInt(n: unknown, min: number, max: number, label: string): number {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new Error(`${label} must be a number`);
  }
  const i = Math.floor(n);
  if (i < min || i > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return i;
}

// ---------------------------------------------------------------------------
// Defaults (mirrored from sort-rank.ts; re-declared here so the API layer is
// self-contained).
// ---------------------------------------------------------------------------

const DEFAULT_SHIPPING_BASE: Record<ShippingLevel, number> = {
  standard: 100,
  expedited: 300,
  overnight: 500,
};
const DEFAULT_SLA_DAYS = 3;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function readSettings(): Promise<{ shippingBase: Record<ShippingLevel, number>; slaDefaultDays: number }> {
  const shippingBase: Record<ShippingLevel, number> = { ...DEFAULT_SHIPPING_BASE };
  let slaDefaultDays = DEFAULT_SLA_DAYS;

  const rows = await db.execute<{ key: string; value: string | null }>(sql`
    SELECT key, value
    FROM warehouse.echelon_settings
    WHERE key IN (
      'priority.shipping_base.standard',
      'priority.shipping_base.expedited',
      'priority.shipping_base.overnight',
      'priority.sla_default_days'
    )
  `);

  for (const row of rows.rows) {
    const n = row.value == null ? NaN : Number(row.value);
    if (!Number.isFinite(n)) continue;
    switch (row.key) {
      case "priority.shipping_base.standard": shippingBase.standard = n; break;
      case "priority.shipping_base.expedited": shippingBase.expedited = n; break;
      case "priority.shipping_base.overnight": shippingBase.overnight = n; break;
      case "priority.sla_default_days": slaDefaultDays = n; break;
    }
  }

  return { shippingBase, slaDefaultDays };
}

async function readChannels(): Promise<PickPriorityPayload["channels"]> {
  // Order: active channels first, then by name. sla_days NULL = inherit global.
  const rows = await db.execute<{
    id: number;
    name: string | null;
    provider: string | null;
    status: string | null;
    sla_days: number | null;
  }>(sql`
    SELECT id, name, provider, status, sla_days
    FROM channels.channels
    ORDER BY (status = 'active') DESC, name
  `);

  return rows.rows.map((r) => ({
    id: Number(r.id),
    name: r.name ?? "(unnamed channel)",
    provider: r.provider ?? "manual",
    status: r.status ?? "pending_setup",
    slaDays: r.sla_days == null ? null : Number(r.sla_days),
  }));
}

async function readPlans(): Promise<PickPriorityPayload["plans"]> {
  const rows = await db.execute<{
    id: string;
    name: string | null;
    tier_level: number | null;
    priority_modifier: number;
    primary_color: string | null;
    is_active: boolean | null;
  }>(sql`
    SELECT id, name, tier_level, priority_modifier, primary_color, is_active
    FROM membership.plans
    ORDER BY COALESCE(tier_level, 9999), name
  `);

  return rows.rows.map((r) => ({
    id: r.id,
    name: r.name ?? "(unnamed plan)",
    tierLevel: r.tier_level,
    priorityModifier: Number(r.priority_modifier ?? 0),
    primaryColor: r.primary_color,
    isActive: r.is_active === true,
  }));
}

async function upsertSetting(key: string, value: number, type: string = "number"): Promise<void> {
  // The four priority keys are seeded by migration 0559, so an UPDATE is
  // sufficient in production. We keep an UPSERT here for dev environments
  // where the seed may not have run.
  await db.execute(sql`
    INSERT INTO warehouse.echelon_settings (key, value, type, category, description)
    VALUES (${key}, ${String(value)}, ${type}, 'pick_priority', NULL)
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value,
          updated_at = now()
  `);
}

async function recomputeAndQueueActiveSortRankSync(
  context: string,
): Promise<{ recomputed: number; queued: number; failed: number }> {
  const { updated, orderIds } = await recomputeAllActiveSortRanksDetailed();
  let queued = 0;
  let failed = 0;

  for (const orderId of orderIds) {
    try {
      await enqueueShipStationSortRankSyncRetry(db, orderId, context);
      queued++;
    } catch (err: any) {
      failed++;
      console.error(
        `[PickPriority] Failed to queue ShipStation sort_rank sync for WMS order ${orderId}:`,
        err?.message ?? err,
      );
    }
  }

  return { recomputed: updated, queued, failed };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerPickPriorityRoutes(app: Express): void {
  // GET \u2014 return current settings + all plans.
  app.get(
    "/api/admin/pick-priority",
    requireAuth,
    requirePermission("settings", "view"),
    async (_req: Request, res: Response) => {
      try {
        const [{ shippingBase, slaDefaultDays }, plans, channels] = await Promise.all([
          readSettings(),
          readPlans(),
          readChannels(),
        ]);
        const payload: PickPriorityPayload = { shippingBase, slaDefaultDays, plans, channels };
        res.json(payload);
      } catch (err: any) {
        console.error("[PickPriority] GET failed:", err.message);
        res.status(500).json({ error: err.message });
      }
    },
  );

  // PATCH \u2014 partial update. Writes dirty keys to echelon_settings and dirty
  // plan modifiers to membership.plans. Settings cache is invalidated so the
  // next WMS sync picks up the new values immediately.
  app.patch(
    "/api/admin/pick-priority",
    requireAuth,
    requirePermission("settings", "edit"),
    async (req: Request, res: Response) => {
      try {
        const body = (req.body ?? {}) as PickPriorityUpdate;

        const tasks: Promise<unknown>[] = [];
        let affectsSortRank = false;

        if (body.shippingBase) {
          for (const level of ["standard", "expedited", "overnight"] as const) {
            const raw = body.shippingBase[level];
            if (raw == null) continue;
            const v = validateInt(raw, SHIPPING_MIN, SHIPPING_MAX, `shippingBase.${level}`);
            tasks.push(upsertSetting(`priority.shipping_base.${level}`, v));
            affectsSortRank = true;
          }
        }

        if (body.slaDefaultDays != null) {
          const v = validateInt(body.slaDefaultDays, SLA_MIN, SLA_MAX, "slaDefaultDays");
          tasks.push(upsertSetting("priority.sla_default_days", v));
          affectsSortRank = true;
        }

        if (body.planModifiers && typeof body.planModifiers === "object") {
          for (const [planId, raw] of Object.entries(body.planModifiers)) {
            if (!planId || typeof planId !== "string") {
              throw new Error("planModifiers keys must be plan ids");
            }
            const v = validateInt(raw, PLAN_MOD_MIN, PLAN_MOD_MAX, `planModifiers[${planId}]`);
            tasks.push(db.execute(sql`
              UPDATE membership.plans
              SET priority_modifier = ${v}
              WHERE id = ${planId}
            `));
            affectsSortRank = true;
          }
        }

        if (body.channelSlaDays && typeof body.channelSlaDays === "object") {
          for (const [channelIdRaw, raw] of Object.entries(body.channelSlaDays)) {
            const channelId = Number(channelIdRaw);
            if (!Number.isInteger(channelId) || channelId <= 0) {
              throw new Error("channelSlaDays keys must be channel ids");
            }
            // null clears the per-channel SLA (channel reverts to global default).
            if (raw === null) {
              tasks.push(db.execute(sql`
                UPDATE channels.channels
                SET sla_days = NULL, updated_at = now()
                WHERE id = ${channelId}
              `));
              affectsSortRank = true;
              continue;
            }
            const v = validateInt(raw, CHANNEL_SLA_MIN, CHANNEL_SLA_MAX, `channelSlaDays[${channelId}]`);
            tasks.push(db.execute(sql`
              UPDATE channels.channels
              SET sla_days = ${v}, updated_at = now()
              WHERE id = ${channelId}
            `));
            affectsSortRank = true;
          }
        }

        await Promise.all(tasks);
        invalidatePickPrioritySettingsCache();
        const sortRankSync = affectsSortRank
          ? await recomputeAndQueueActiveSortRankSync("pick-priority settings changed")
          : { recomputed: 0, queued: 0, failed: 0 };

        // Return the fresh payload so the client stays in sync.
        const [{ shippingBase, slaDefaultDays }, plans, channels] = await Promise.all([
          readSettings(),
          readPlans(),
          readChannels(),
        ]);
        res.json({ shippingBase, slaDefaultDays, plans, channels, sortRankSync });
      } catch (err: any) {
        const status = /must be (a number|between)/.test(err.message) ? 400 : 500;
        console.error("[PickPriority] PATCH failed:", err.message);
        res.status(status).json({ error: err.message });
      }
    },
  );

  console.log("[PickPriority] Admin routes registered at /api/admin/pick-priority");
}
