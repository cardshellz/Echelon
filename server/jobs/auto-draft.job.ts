/**
 * Auto-Draft Job
 *
 * Runs at 2am daily (via Heroku Scheduler or manual trigger).
 * Analyzes reorder needs, creates/updates draft POs grouped by preferred vendor.
 */

import { db } from "../db";
import { procurementMethods } from "../modules/procurement/procurement.storage";
import {
  generatePurchasingRecommendations,
  passesAutoDraftApprovalPolicy,
  type AutoDraftRecommendationSettings,
  type PurchasingRecommendationProductMeta,
  type PurchasingRecommendationRawRow,
} from "../modules/procurement/purchasing-recommendation.engine";
import {
  buildPurchasingRecommendationRunDetail,
  type PurchasingRecommendationRunPoMutation,
} from "../modules/procurement/purchasing-recommendation.run-detail";
import { createPurchasingService } from "../modules/procurement/purchasing.service";
import {
  purchaseOrders,
  reorderExclusionRules,
  products,
  sql,
  eq,
  and,
} from "../storage/base";

interface AutoDraftOptions {
  triggeredBy: "scheduler" | "manual";
  triggeredByUser?: string;
}

function shouldCreateDraftPos(settings: AutoDraftRecommendationSettings): boolean {
  return settings.autoDraftMode !== "review_only";
}

export async function runAutoDraftJob(options: AutoDraftOptions) {
  const storage = procurementMethods;
  const purchasing = createPurchasingService(db, storage as any);

  // Insert running record
  const runRecord = await storage.createAutoDraftRun({
    triggeredBy: options.triggeredBy,
    triggeredByUser: options.triggeredByUser,
    status: "running",
  });

  let itemsAnalyzed = 0;
  let posCreated = 0;
  let posUpdated = 0;
  let linesAdded = 0;
  let skippedNoVendor = 0;
  let skippedOnOrder = 0;
  let skippedExcluded = 0;
  let recommendationRunDetail: ReturnType<typeof buildPurchasingRecommendationRunDetail> | null = null;

  try {
    // Get settings
    const settings = await storage.getAutoDraftSettings();

    // Get lookback
    const lookbackDays = 30; // Default

    // Get reorder analysis data
    const rawData = await storage.getReorderAnalysisData(lookbackDays);
    itemsAnalyzed = rawData.length;

    // Get exclusion rules
    const rules = await db.select().from(reorderExclusionRules);

    // Get product metadata for exclusion checking
    const productMetaRows = await db.execute(sql`
      SELECT id, category, brand, product_type, sku, tags, reorder_excluded
      FROM catalog.products WHERE is_active = true
    `);
    const productMeta = new Map<number, PurchasingRecommendationProductMeta>();
    for (const pm of productMetaRows.rows as any[]) {
      productMeta.set(pm.id, pm);
    }

    const recommendationResult = generatePurchasingRecommendations({
      rows: rawData as PurchasingRecommendationRawRow[],
      lookbackDays,
      productMetaById: productMeta,
      exclusionRules: rules,
      autoDraftSettings: settings,
      requireVendor: Boolean(settings.skipNoVendor),
    });
    skippedExcluded = recommendationResult.summary.excludedCount;
    skippedNoVendor = recommendationResult.summary.skippedNoVendor;
    skippedOnOrder = recommendationResult.summary.skippedOnOrder;

    const eligibleItems: Array<{
      productId: number;
      productVariantId: number;
      sku: string;
      productName: string;
      suggestedOrderQty: number;
      suggestedOrderPieces: number;
      orderUomUnits: number;
      onOrderPieces: number;
      openPoCount: number;
      status: string;
      preferredVendorId: number | null;
      estimatedCostCents: number | null;
    }> = recommendationResult.items
      .filter((item) => passesAutoDraftApprovalPolicy(item, settings))
      .map((item) => ({
        productId: item.productId,
        productVariantId: item.productVariantId ?? item.productId,
        sku: item.sku,
        productName: item.productName,
        suggestedOrderQty: item.suggestedOrderQty,
        suggestedOrderPieces: item.suggestedOrderPieces,
        orderUomUnits: item.orderUomUnits,
        onOrderPieces: item.onOrderPieces,
        openPoCount: item.openPoCount,
        status: item.status,
        preferredVendorId: item.preferredVendorId,
        estimatedCostCents: item.estimatedCostCents,
      }));

    // Group by vendor
    const vendorGroups = new Map<number | null, typeof eligibleItems>();
    for (const item of eligibleItems) {
      const key = item.preferredVendorId;
      if (!vendorGroups.has(key)) vendorGroups.set(key, []);
      vendorGroups.get(key)!.push(item);
    }

    const today = new Date().toISOString().split("T")[0];
    const poMutations: PurchasingRecommendationRunPoMutation[] = [];
    const createDraftPos = shouldCreateDraftPos(settings);

    // Process each vendor group
    for (const [vendorId, items] of createDraftPos ? vendorGroups : []) {
      if (!vendorId) continue; // Skip no-vendor items (already counted)

      // Check if a draft PO already exists today for this vendor
      const existingPOs = await db.select()
        .from(purchaseOrders)
        .where(and(
          eq(purchaseOrders.vendorId, vendorId),
          eq(purchaseOrders.status, "draft"),
          eq(purchaseOrders.source, "auto_draft"),
          sql`${purchaseOrders.autoDraftDate} = ${today}::date`,
        ))
        .limit(1);

      let poId: number;

      if (existingPOs.length > 0) {
        // Existing draft PO — add missing lines
        poId = existingPOs[0].id;
        posUpdated++;

        const existingLines = await storage.getPurchaseOrderLines(poId);
        const existingProductIds = new Set(existingLines.map((l: any) => l.productVariantId));

        const newLines = items
          .filter((item) => !existingProductIds.has(item.productVariantId))
          .map((item, idx) => {
            return {
              purchaseOrderId: poId,
              lineNumber: existingLines.length + idx + 1,
              productId: item.productId,
              productVariantId: item.productVariantId,
              sku: item.sku,
              productName: item.productName,
              orderQty: item.suggestedOrderQty,
              unitOfMeasure: item.orderUomUnits > 1 ? "case" : "each",
              unitsPerUom: item.orderUomUnits,
              unitCostCents: item.estimatedCostCents ?? 0,
              lineTotalCents: (item.estimatedCostCents ?? 0) * item.suggestedOrderQty,
              status: "open",
            };
          });

        if (newLines.length > 0) {
          await storage.bulkCreatePurchaseOrderLines(newLines as any);
          linesAdded += newLines.length;
        }
        poMutations.push({
          vendorId,
          poId,
          action: "updated",
          linesAdded: newLines.length,
        });
      } else {
        // Create new draft PO
        const po = await purchasing.createPO({
          vendorId,
          poType: "standard",
          priority: "normal",
          createdBy: options.triggeredByUser || "auto-draft",
        });

        // Update source and auto_draft_date
        await storage.updatePurchaseOrder(po.id, {
          source: "auto_draft",
          autoDraftDate: today,
        });

        poId = po.id;
        posCreated++;

        // Create lines
        const lineData = items.map((item, idx) => ({
          purchaseOrderId: poId,
          lineNumber: idx + 1,
          productId: item.productId,
          productVariantId: item.productVariantId,
          sku: item.sku,
          productName: item.productName,
          orderQty: item.suggestedOrderQty,
          unitOfMeasure: item.orderUomUnits > 1 ? "case" : "each",
          unitsPerUom: item.orderUomUnits,
          unitCostCents: item.estimatedCostCents ?? 0,
          lineTotalCents: (item.estimatedCostCents ?? 0) * item.suggestedOrderQty,
          status: "open",
        }));

        if (lineData.length > 0) {
          await storage.bulkCreatePurchaseOrderLines(lineData as any);
          linesAdded += lineData.length;
        }
        poMutations.push({
          vendorId,
          poId,
          action: "created",
          linesAdded: lineData.length,
        });
      }

      // Recalculate totals
      await purchasing.recalculateTotals(poId);
    }

    recommendationRunDetail = buildPurchasingRecommendationRunDetail(recommendationResult, {
      lookbackDays,
      settings,
      poMutations,
    });

    // Mark success
    await storage.updateAutoDraftRun(runRecord.id, {
      status: "success",
      itemsAnalyzed,
      posCreated,
      posUpdated,
      linesAdded,
      skippedNoVendor,
      skippedOnOrder,
      skippedExcluded,
      summaryJson: recommendationRunDetail,
      finishedAt: new Date(),
    });

    console.log(`[Auto-draft] Complete: ${itemsAnalyzed} analyzed, ${posCreated} created, ${posUpdated} updated, ${linesAdded} lines added, ${skippedNoVendor} skipped (no vendor), ${skippedExcluded} excluded`);
  } catch (error: any) {
    console.error("[Auto-draft] Failed:", error);
    await storage.updateAutoDraftRun(runRecord.id, {
      status: "error",
      errorMessage: error?.message || "Unknown error",
      itemsAnalyzed,
      posCreated,
      posUpdated,
      linesAdded,
      skippedNoVendor,
      skippedOnOrder,
      skippedExcluded,
      summaryJson: recommendationRunDetail,
      finishedAt: new Date(),
    });
    throw error;
  }
}
