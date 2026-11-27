import {
  adjustmentReasons,
  cycleCountItems,
  cycleCounts,
  inventoryLevels,
  inventoryTransactions,
  warehouseSettings,
} from "@shared/schema";
import { and, eq, sql, type SQL } from "drizzle-orm";

export async function seedDefaultAdjustmentReasonsInInventory(
  executor: {
    delete: (...args: any[]) => any;
    insert: (...args: any[]) => any;
  },
  oldCodes: readonly string[],
  defaultReasons: readonly Record<string, unknown>[],
): Promise<void> {
  for (const code of oldCodes) {
    try {
      await executor.delete(adjustmentReasons).where(eq(adjustmentReasons.code, code));
    } catch {
      // Ignore row-level FK / early-startup errors during idempotent seeding
    }
  }

  for (const reason of defaultReasons) {
    try {
      await executor
        .insert(adjustmentReasons)
        .values(reason as any)
        .onConflictDoNothing();
    } catch {
      // Ignore duplicate / early-startup errors during idempotent seeding
    }
  }
}

export async function deleteZeroPreLedgerInventoryLevelsByVariantIdInInventory(
  executor: { delete: (...args: any[]) => any },
  variantId: number,
): Promise<number> {
  const result = await executor
    .delete(inventoryLevels)
    .where(
      and(
        eq(inventoryLevels.productVariantId, variantId),
        eq(inventoryLevels.variantQty, 0),
        eq(inventoryLevels.reservedQty, 0),
        eq(inventoryLevels.pickedQty, 0),
        eq(inventoryLevels.packedQty, 0),
        sql`NOT EXISTS (SELECT 1 FROM inventory.quantity_ledger_opening)`,
      ),
    )
    .returning();
  return result.length;
}

export async function deleteZeroInventoryLevelsByVariantIdInTx(
  tx: { delete: (...args: any[]) => any },
  variantId: number,
): Promise<number> {
  const rows = await tx
    .delete(inventoryLevels)
    .where(
      and(
        eq(inventoryLevels.productVariantId, variantId),
        eq(inventoryLevels.variantQty, 0),
        eq(inventoryLevels.reservedQty, 0),
        eq(inventoryLevels.pickedQty, 0),
        eq(inventoryLevels.packedQty, 0),
      ),
    )
    .returning({ id: inventoryLevels.id });
  return rows.length;
}

export async function insertShopifyBackfillInventoryLevelAndReceiptTxnInInventory(
  executor: { insert: (...args: any[]) => any },
  input: {
    warehouseLocationId: number;
    productVariantId: number;
    qtyToImport: number;
    shopifyInventoryItemId: string;
  },
): Promise<void> {
  await executor.insert(inventoryLevels).values({
    warehouseLocationId: input.warehouseLocationId,
    productVariantId: input.productVariantId,
    variantQty: input.qtyToImport,
    reservedQty: 0,
    pickedQty: 0,
    packedQty: 0,
    backorderQty: 0,
  });

  await executor.insert(inventoryTransactions).values({
    productVariantId: input.productVariantId,
    toLocationId: input.warehouseLocationId,
    transactionType: "receipt",
    variantQtyDelta: input.qtyToImport,
    variantQtyBefore: 0,
    variantQtyAfter: input.qtyToImport,
    referenceType: "shopify_backfill",
    referenceId: `shopify-inv-item-${input.shopifyInventoryItemId}`,
    notes: `Backfill from Shopify inventory level (${input.qtyToImport} units)`,
    userId: "system:catalog-backfill",
  });
}

export async function insertOrphanedReservationUnreserveTransactionInInventory(
  executor: { insert: (...args: any[]) => any },
  input: {
    productVariantId: number;
    warehouseLocationId: number;
    excess: number;
    userId?: string | null;
  },
): Promise<void> {
  await executor.insert(inventoryTransactions).values({
    productVariantId: input.productVariantId,
    fromLocationId: input.warehouseLocationId,
    transactionType: "unreserve",
    variantQtyDelta: 0,
    reservedQtyDelta: -input.excess,
    notes: "Orphaned reservation released: inventory count dropped below reserved amount",
    userId: input.userId || null,
  });
}

export async function repairOrphanedPickedInventoryLevelInTx(
  tx: { execute: (...args: any[]) => any },
  input: {
    levelId: number;
    productVariantId: number;
    warehouseLocationId: number;
    activeQty: number;
    orphanQty: number;
  },
): Promise<void> {
  await tx.execute(sql`
    UPDATE inventory.inventory_levels
    SET picked_qty = ${input.activeQty},
        updated_at = NOW()
    WHERE id = ${input.levelId}
  `);

  await tx.execute(sql`
    INSERT INTO inventory.inventory_transactions (
      product_variant_id,
      from_location_id,
      transaction_type,
      variant_qty_delta,
      variant_qty_before,
      variant_qty_after,
      source_state,
      target_state,
      reference_type,
      reference_id,
      notes,
      created_at
    ) VALUES (
      ${input.productVariantId},
      ${input.warehouseLocationId},
      'ship',
      0,
      0,
      0,
      'picked',
      'shipped',
      'system_cleanup',
      'script_fix_orphans',
      ${`Backfilled ${input.orphanQty} orphaned picked items missing from ShipStation V2 webhook.`},
      NOW()
    )
  `);
}

export async function cancelShipmentBlockingReplenTasksForOrderInInventory(
  executor: { execute: (...args: any[]) => any },
  orderId: number,
  blockerNote: string,
): Promise<{ rows?: unknown[] }> {
  return executor.execute(sql`
    UPDATE inventory.replen_tasks
    SET
      status = 'cancelled',
      blocks_shipment = FALSE,
      notes = CONCAT(COALESCE(notes, ''), CASE WHEN COALESCE(notes, '') = '' THEN '' ELSE E'\n' END, ${blockerNote})
    WHERE order_id = ${orderId}
      AND blocks_shipment = TRUE
      AND status NOT IN ('completed', 'cancelled')
    RETURNING id
  `);
}

export async function updateWarehouseOrderCombiningSettingInInventory(
  executor: { update: (...args: any[]) => any },
  warehouseId: number,
  enableOrderCombining: number,
): Promise<void> {
  await executor
    .update(warehouseSettings)
    .set({ enableOrderCombining, updatedAt: new Date() })
    .where(eq(warehouseSettings.warehouseId, warehouseId));
}

export async function insertWarehouseOrderCombiningSettingInInventory(
  executor: { insert: (...args: any[]) => any },
  input: {
    warehouseId: number;
    warehouseCode: string;
    warehouseName: string;
    enableOrderCombining: number;
  },
): Promise<void> {
  await executor.insert(warehouseSettings).values({
    warehouseId: input.warehouseId,
    warehouseCode: input.warehouseCode,
    warehouseName: input.warehouseName,
    enableOrderCombining: input.enableOrderCombining,
  });
}

export async function updateDefaultOrderCombiningSettingInInventory(
  executor: { update: (...args: any[]) => any },
  enableOrderCombining: number,
): Promise<void> {
  await executor
    .update(warehouseSettings)
    .set({ enableOrderCombining, updatedAt: new Date() })
    .where(eq(warehouseSettings.warehouseCode, "DEFAULT"));
}

export async function insertDefaultOrderCombiningSettingInInventory(
  executor: { insert: (...args: any[]) => any },
  enableOrderCombining: number,
): Promise<void> {
  await executor.insert(warehouseSettings).values({
    warehouseCode: "DEFAULT",
    warehouseName: "Default",
    enableOrderCombining,
  });
}

export async function updateDefaultProcurementPolicySettingsWithCasInTx(
  tx: { execute: (...args: any[]) => any },
  input: {
    id: number;
    previousRevision: number;
    revision: number;
    assignments: SQL[];
    updatedAt: Date;
  },
): Promise<{ rows: unknown[] }> {
  return tx.execute(sql`
    UPDATE inventory.warehouse_settings SET ${sql.join(input.assignments, sql`, `)},
      procurement_policy_revision=${input.revision}, updated_at=${input.updatedAt}
    WHERE id=${input.id} AND warehouse_code='DEFAULT' AND procurement_policy_revision=${input.previousRevision}
    RETURNING id
  `);
}

export async function updateWarehouseAutoDraftAndForecastSettingsInTx(
  tx: { execute: (...args: any[]) => any },
  input: {
    targetId: number;
    autoDraftMode: string | null;
    approvalPolicy: string | null;
    includeOrderSoon: boolean | null;
    skipOnOpenPo: boolean | null;
    skipNoVendor: boolean | null;
    candidateScoreStrongThreshold: number | null;
    candidateScoreReviewThreshold: number | null;
    standardWindowDays: number | null;
    forecastMethod: string | null;
    shortWindowDays: number | null;
    longWindowDays: number | null;
    seasonalEnabled: boolean | null;
    seasonalWindowDays: number | null;
    weightShort: number | null;
    weightStandard: number | null;
    weightLong: number | null;
    weightSeasonal: number | null;
    forwardDemandEnabled: boolean | null;
    forwardDemandHorizonDays: number | null;
    forwardDemandHighWeight: number | null;
    forwardDemandMediumWeight: number | null;
    forwardDemandLowWeight: number | null;
    automationMinimumOrderCount: number | null;
    automationMinimumActiveDays: number | null;
    rfqDraftAutomationMode: string | null;
    rfqDraftMinimumConfidence: string | null;
    rfqDraftRequireTrustedForecast: boolean | null;
    rfqDraftMaximumLinesPerRun: number | null;
    reviewPendingWarningDays: number | null;
    reviewPendingCriticalDays: number | null;
    supplierSendWarningDays: number | null;
    supplierSendCriticalDays: number | null;
    supplierFollowupWarningDays: number | null;
    supplierFollowupCriticalDays: number | null;
    receivingWarningDays: number | null;
    receivingCriticalDays: number | null;
    apCloseoutWarningDays: number | null;
    apCloseoutCriticalDays: number | null;
    exceptionBlockedWarningDays: number | null;
    exceptionBlockedCriticalDays: number | null;
    closeoutWarningDays: number | null;
    closeoutCriticalDays: number | null;
  },
): Promise<void> {
  await tx.execute(sql`
    UPDATE inventory.warehouse_settings SET
      auto_draft_mode = COALESCE(${input.autoDraftMode}, auto_draft_mode),
      auto_draft_approval_policy = COALESCE(${input.approvalPolicy}, auto_draft_approval_policy),
      auto_draft_include_order_soon = COALESCE(${input.includeOrderSoon}, auto_draft_include_order_soon),
      auto_draft_skip_on_open_po = COALESCE(${input.skipOnOpenPo}, auto_draft_skip_on_open_po),
      auto_draft_skip_no_vendor = COALESCE(${input.skipNoVendor}, auto_draft_skip_no_vendor),
      recommendation_candidate_score_strong_threshold = COALESCE(${input.candidateScoreStrongThreshold}, recommendation_candidate_score_strong_threshold),
      recommendation_candidate_score_review_threshold = COALESCE(${input.candidateScoreReviewThreshold}, recommendation_candidate_score_review_threshold),
      velocity_lookback_days = COALESCE(${input.standardWindowDays}, velocity_lookback_days),
      purchasing_forecast_method = COALESCE(${input.forecastMethod}, purchasing_forecast_method),
      purchasing_forecast_short_window_days = COALESCE(${input.shortWindowDays}, purchasing_forecast_short_window_days),
      purchasing_forecast_long_window_days = COALESCE(${input.longWindowDays}, purchasing_forecast_long_window_days),
      purchasing_forecast_seasonal_enabled = COALESCE(${input.seasonalEnabled}, purchasing_forecast_seasonal_enabled),
      purchasing_forecast_seasonal_window_days = COALESCE(${input.seasonalWindowDays}, purchasing_forecast_seasonal_window_days),
      purchasing_forecast_weight_short = COALESCE(${input.weightShort}, purchasing_forecast_weight_short),
      purchasing_forecast_weight_standard = COALESCE(${input.weightStandard}, purchasing_forecast_weight_standard),
      purchasing_forecast_weight_long = COALESCE(${input.weightLong}, purchasing_forecast_weight_long),
      purchasing_forecast_weight_seasonal = COALESCE(${input.weightSeasonal}, purchasing_forecast_weight_seasonal),
      purchasing_forward_demand_enabled = COALESCE(${input.forwardDemandEnabled}, purchasing_forward_demand_enabled),
      purchasing_forward_demand_horizon_days = COALESCE(${input.forwardDemandHorizonDays}, purchasing_forward_demand_horizon_days),
      purchasing_forward_demand_high_weight = COALESCE(${input.forwardDemandHighWeight}, purchasing_forward_demand_high_weight),
      purchasing_forward_demand_medium_weight = COALESCE(${input.forwardDemandMediumWeight}, purchasing_forward_demand_medium_weight),
      purchasing_forward_demand_low_weight = COALESCE(${input.forwardDemandLowWeight}, purchasing_forward_demand_low_weight),
      purchasing_automation_min_order_count = COALESCE(${input.automationMinimumOrderCount}, purchasing_automation_min_order_count),
      purchasing_automation_min_active_days = COALESCE(${input.automationMinimumActiveDays}, purchasing_automation_min_active_days),
      rfq_draft_automation_mode = COALESCE(${input.rfqDraftAutomationMode}, rfq_draft_automation_mode),
      rfq_draft_minimum_confidence = COALESCE(${input.rfqDraftMinimumConfidence}, rfq_draft_minimum_confidence),
      rfq_draft_require_trusted_forecast = COALESCE(${input.rfqDraftRequireTrustedForecast}, rfq_draft_require_trusted_forecast),
      rfq_draft_maximum_lines_per_run = COALESCE(${input.rfqDraftMaximumLinesPerRun}, rfq_draft_maximum_lines_per_run),
      auto_draft_po_review_warning_days = COALESCE(${input.reviewPendingWarningDays}, auto_draft_po_review_warning_days),
      auto_draft_po_review_critical_days = COALESCE(${input.reviewPendingCriticalDays}, auto_draft_po_review_critical_days),
      auto_draft_po_supplier_send_warning_days = COALESCE(${input.supplierSendWarningDays}, auto_draft_po_supplier_send_warning_days),
      auto_draft_po_supplier_send_critical_days = COALESCE(${input.supplierSendCriticalDays}, auto_draft_po_supplier_send_critical_days),
      auto_draft_po_supplier_followup_warning_days = COALESCE(${input.supplierFollowupWarningDays}, auto_draft_po_supplier_followup_warning_days),
      auto_draft_po_supplier_followup_critical_days = COALESCE(${input.supplierFollowupCriticalDays}, auto_draft_po_supplier_followup_critical_days),
      auto_draft_po_receiving_warning_days = COALESCE(${input.receivingWarningDays}, auto_draft_po_receiving_warning_days),
      auto_draft_po_receiving_critical_days = COALESCE(${input.receivingCriticalDays}, auto_draft_po_receiving_critical_days),
      auto_draft_po_ap_closeout_warning_days = COALESCE(${input.apCloseoutWarningDays}, auto_draft_po_ap_closeout_warning_days),
      auto_draft_po_ap_closeout_critical_days = COALESCE(${input.apCloseoutCriticalDays}, auto_draft_po_ap_closeout_critical_days),
      auto_draft_po_exception_warning_days = COALESCE(${input.exceptionBlockedWarningDays}, auto_draft_po_exception_warning_days),
      auto_draft_po_exception_critical_days = COALESCE(${input.exceptionBlockedCriticalDays}, auto_draft_po_exception_critical_days),
      auto_draft_po_closeout_warning_days = COALESCE(${input.closeoutWarningDays}, auto_draft_po_closeout_warning_days),
      auto_draft_po_closeout_critical_days = COALESCE(${input.closeoutCriticalDays}, auto_draft_po_closeout_critical_days)
    WHERE id = ${input.targetId}
  `);
}

export async function relocateSlotReplenPointersInInventory(
  tx: { execute: (...args: any[]) => any },
  input: {
    productVariantId: number;
    fromLocationId: number;
    toLocationId: number;
  },
): Promise<{ migratedConfigs: number; migratedTasks: number }> {
  if (input.fromLocationId === input.toLocationId) {
    return { migratedConfigs: 0, migratedTasks: 0 };
  }

  let migratedConfigs = 0;
  const cfgReg = await tx.execute(sql`SELECT to_regclass('inventory.location_replen_config') AS reg`);
  if ((cfgReg?.rows?.[0] as any)?.reg) {
    const movedCfgs = await tx.execute(sql`
      UPDATE inventory.location_replen_config src
      SET warehouse_location_id = ${input.toLocationId},
          updated_at = NOW()
      WHERE src.warehouse_location_id = ${input.fromLocationId}
        AND src.product_variant_id = ${input.productVariantId}
        AND NOT EXISTS (
          SELECT 1
          FROM inventory.location_replen_config dst
          WHERE dst.warehouse_location_id = ${input.toLocationId}
            AND dst.product_variant_id = ${input.productVariantId}
        )
      RETURNING src.id
    `);
    migratedConfigs = Array.isArray(movedCfgs?.rows) ? movedCfgs.rows.length : 0;

    // Clean up any leftover duplicate source config if destination already had one
    await tx.execute(sql`
      DELETE FROM inventory.location_replen_config
      WHERE warehouse_location_id = ${input.fromLocationId}
        AND product_variant_id = ${input.productVariantId}
    `);
  }

  let migratedTasks = 0;
  const taskReg = await tx.execute(sql`SELECT to_regclass('inventory.replen_tasks') AS reg`);
  if ((taskReg?.rows?.[0] as any)?.reg) {
    const movedTasks = await tx.execute(sql`
      UPDATE inventory.replen_tasks
      SET to_location_id = ${input.toLocationId},
          from_location_id = CASE
            WHEN from_location_id = ${input.fromLocationId}
             AND status = 'blocked'
             AND COALESCE(qty_source_units, 0) = 0
            THEN ${input.toLocationId}
            ELSE from_location_id
          END,
          revision = COALESCE(revision, 0) + 1
      WHERE to_location_id = ${input.fromLocationId}
        AND pick_product_variant_id = ${input.productVariantId}
        AND status IN ('pending', 'assigned', 'blocked')
        AND COALESCE(qty_completed, 0) = 0
        AND operation_request_hash IS NULL
      RETURNING id
    `);
    migratedTasks = Array.isArray(movedTasks?.rows) ? movedTasks.rows.length : 0;
  }

  return { migratedConfigs, migratedTasks };
}

/**
 * Queues a non-freezing `draft` Cycle Count for one or more discrepancy bins
 * (e.g. when a picker skips an expected inline case break because stock was
 * physically found in the pick bin, or when an `out_of_stock` short pick occurs
 * while Reserve still shows stock). Because status is `draft`, neither bin has
 * `cycle_count_freeze_id` set while active picking continues.
 */
export async function createDraftDiscrepancyCycleCountInInventory(
  executor: {
    execute?: (query: any) => Promise<any>;
    insert: (...args: any[]) => any;
  },
  input: {
    name: string;
    description: string;
    warehouseId?: number | null;
    locationCodes: readonly string[];
    createdBy?: string | null;
  },
): Promise<{ id: number; deduplicated: boolean } | null> {
  const normalizedCodes = Array.from(
    new Set(
      input.locationCodes
        .map((code) => String(code ?? "").trim().toUpperCase())
        .filter((code) => code.length > 0 && code !== "U" && code !== "UNASSIGNED"),
    ),
  );
  if (normalizedCodes.length === 0) return null;
  const locationCodesCsv = normalizedCodes.join(",");

  if (typeof executor.execute === "function") {
    try {
      const regRes = await executor.execute(sql`SELECT to_regclass('inventory.cycle_counts') AS reg`);
      if ((regRes?.rows ?? []).length > 0 && !(regRes.rows[0] as any)?.reg) {
        return null;
      }
      const existing = await executor.execute(sql`
        SELECT id
        FROM inventory.cycle_counts
        WHERE status IN ('draft', 'in_progress')
          AND UPPER(COALESCE(location_codes, '')) = ${locationCodesCsv}
          AND (${input.warehouseId ?? null}::int IS NULL OR warehouse_id = ${input.warehouseId ?? null} OR warehouse_id IS NULL)
        ORDER BY id DESC
        LIMIT 1
      `);
      const existingId = Number((existing?.rows?.[0] as any)?.id ?? 0);
      if (Number.isInteger(existingId) && existingId > 0) {
        return { id: existingId, deduplicated: true };
      }
    } catch {
      // Fall through to insert if dedup probe is mocked or unavailable in unit tests
    }
  }

  const inserted = await executor
    .insert(cycleCounts)
    .values({
      name: input.name.slice(0, 100),
      description: input.description,
      status: "draft",
      warehouseId: input.warehouseId ?? null,
      locationCodes: locationCodesCsv,
      totalBins: normalizedCodes.length,
      countedBins: 0,
      varianceCount: 0,
      approvedVariances: 0,
      createdBy: input.createdBy ? String(input.createdBy).slice(0, 100) : "system:pick-discrepancy",
    })
    .returning?.({ id: cycleCounts.id });

  const id = Number(inserted?.[0]?.id ?? 0);
  return id > 0 ? { id, deduplicated: false } : null;
}

/**
 * Creates a transient 1-item `in_progress` spot count WITHOUT setting
 * `warehouse_locations.cycle_count_freeze_id`, allowing `reconcileCycleCountInventory`
 * to atomically displace shorted Canonical Claim reservations and zero phantom stock.
 */
export async function createInProgressShortPickSpotCountInInventory(
  executor: {
    insert: (...args: any[]) => any;
  },
  input: {
    name: string;
    description: string;
    warehouseId?: number | null;
    warehouseLocationId: number;
    locationCode: string;
    productVariantId: number;
    productId?: number | null;
    sku: string;
    expectedQty: number;
    countedQty: number;
    varianceReason: string;
    varianceNotes: string;
    actor?: string | null;
  },
): Promise<{ cycleCountId: number; cycleCountItemId: number } | null> {
  const actor = input.actor ? String(input.actor).slice(0, 100) : "system:short-pick";
  const countRows = await executor
    .insert(cycleCounts)
    .values({
      name: input.name.slice(0, 100),
      description: input.description,
      status: "in_progress",
      warehouseId: input.warehouseId ?? null,
      locationCodes: input.locationCode,
      totalBins: 1,
      countedBins: 1,
      varianceCount: input.countedQty !== input.expectedQty ? 1 : 0,
      approvedVariances: 0,
      startedAt: new Date(),
      createdBy: actor,
    })
    .returning?.({ id: cycleCounts.id });
  const cycleCountId = Number(countRows?.[0]?.id ?? 0);
  if (cycleCountId <= 0) return null;

  const varianceQty = input.countedQty - input.expectedQty;
  const itemRows = await executor
    .insert(cycleCountItems)
    .values({
      cycleCountId,
      warehouseLocationId: input.warehouseLocationId,
      productVariantId: input.productVariantId,
      productId: input.productId ?? null,
      expectedSku: input.sku.slice(0, 100),
      expectedQty: input.expectedQty,
      countedSku: input.sku.slice(0, 100),
      countedQty: input.countedQty,
      varianceQty,
      varianceType: varianceQty < 0 ? "quantity_under" : varianceQty > 0 ? "quantity_over" : null,
      varianceReason: input.varianceReason.slice(0, 50),
      varianceNotes: input.varianceNotes,
      status: "variance",
      requiresApproval: 0,
    })
    .returning?.({ id: cycleCountItems.id });
  const cycleCountItemId = Number(itemRows?.[0]?.id ?? 0);
  if (cycleCountItemId <= 0) return null;

  return { cycleCountId, cycleCountItemId };
}

export async function finalizeShortPickSpotCountInInventory(
  executor: {
    execute: (query: any) => Promise<any>;
  },
  cycleCountId: number,
): Promise<void> {
  await executor.execute(sql`
    UPDATE inventory.cycle_counts
    SET status = 'completed',
        approved_variances = variance_count,
        completed_at = NOW(),
        updated_at = NOW()
    WHERE id = ${cycleCountId}
  `);
}
