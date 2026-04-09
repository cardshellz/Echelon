/**
 * Auto-Draft Job
 *
 * Runs at 2am daily (via Heroku Scheduler or manual trigger).
 * Analyzes reorder needs, creates/updates draft POs grouped by preferred vendor.
 */

import { db } from "../db";
import { procurementMethods } from "../modules/procurement/procurement.storage";
import { createPurchasingService } from "../modules/procurement/purchasing.service";
import {
  purchaseOrders,
  purchaseOrderLines,
  vendors,
  vendorProducts,
  reorderExclusionRules,
  autoDraftRuns,
  products,
  sql,
  eq,
  and,
  inArray,
  desc,
} from "../storage/base";

interface AutoDraftOptions {
  triggeredBy: "scheduler" | "manual";
  triggeredByUser?: string;
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

  try {
    // Get settings
    const settings = await storage.getAutoDraftSettings();

    // Get lookback
    const lookbackDays = 30; // Default

    // Get reorder analysis data
    const rawData = await storage.getReorderAnalysisData(lookbackDays);

    // Get exclusion rules
    const rules = await db.select().from(reorderExclusionRules);

    // Get product metadata for exclusion checking
    const productMetaRows = await db.execute(sql`
      SELECT id, category, brand, product_type, sku, reorder_excluded
      FROM products WHERE is_active = true
    `);
    const productMeta = new Map<number, any>();
    for (const pm of productMetaRows.rows as any[]) {
      productMeta.set(pm.id, pm);
    }

    const isExcluded = (row: any): boolean => {
      const meta = productMeta.get(row.product_id) || {};
      if (meta.reorder_excluded) return true;
      for (const r of rules) {
        const val = String(r.value).toLowerCase();
        switch (r.field) {
          case "category":
            if ((meta.category || "").toLowerCase() === val) return true;
            break;
          case "brand":
            if ((meta.brand || "").toLowerCase() === val) return true;
            break;
          case "product_type":
            if ((meta.product_type || "").toLowerCase() === val) return true;
            break;
          case "sku_prefix":
            if ((meta.sku || "").toLowerCase().startsWith(val)) return true;
            break;
          case "sku_exact":
            if ((meta.sku || "").toLowerCase() === val) return true;
            break;
        }
      }
      return false;
    };

    // Classify and filter items
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
    }> = [];

    for (const r of rawData) {
      itemsAnalyzed++;

      // Check exclusion
      if (isExcluded(r)) {
        skippedExcluded++;
        continue;
      }

      // Calculate status
      const totalOnHand = Number(r.total_pieces);
      const totalReserved = Number(r.total_reserved_pieces);
      const totalOutbound = Number(r.total_outbound_pieces);
      const onOrderPieces = Number(r.on_order_pieces);
      const available = totalOnHand - totalReserved;
      const avgDailyUsage = lookbackDays > 0 ? totalOutbound / lookbackDays : 0;
      const leadTimeDays = Number(r.lead_time_days);
      const safetyStockDays = Number(r.safety_stock_days);
      const reorderPoint = Math.ceil((leadTimeDays + safetyStockDays) * avgDailyUsage);
      const effectiveSupply = available + onOrderPieces;
      const rawOrderQtyPieces = Math.max(0, reorderPoint - effectiveSupply);
      const orderUomUnits = Number(r.order_uom_units) || 1;
      const suggestedOrderQty = orderUomUnits > 1 ? Math.ceil(rawOrderQtyPieces / orderUomUnits) : Math.ceil(rawOrderQtyPieces);

      let status: string;
      if (available <= 0) {
        status = "stockout";
      } else if (avgDailyUsage === 0) {
        status = "no_movement";
      } else if (available <= reorderPoint && onOrderPieces > 0 && effectiveSupply >= reorderPoint) {
        status = "on_order";
      } else if (available <= reorderPoint) {
        status = "order_now";
      } else if (available / avgDailyUsage <= leadTimeDays * 1.5) {
        status = "order_soon";
      } else {
        status = "ok";
      }

      // Only include stockout + order_now (optionally order_soon)
      const includeStatuses = ["stockout", "order_now"];
      if (settings.includeOrderSoon) includeStatuses.push("order_soon");
      if (!includeStatuses.includes(status)) continue;

      // Skip items already on open PO (if setting enabled)
      if (settings.skipOnOpenPo && onOrderPieces > 0 && effectiveSupply >= reorderPoint) {
        skippedOnOrder++;
        continue;
      }

      // Look up preferred vendor
      const [preferredVendor] = await db.select()
        .from(vendorProducts)
        .where(and(
          eq(vendorProducts.productId, r.product_id),
          eq(vendorProducts.isPreferred, 1),
          eq(vendorProducts.isActive, 1),
        ))
        .limit(1);

      if (!preferredVendor) {
        if (settings.skipNoVendor) {
          skippedNoVendor++;
          continue;
        }
      }

      eligibleItems.push({
        productId: r.product_id,
        productVariantId: r.variant_id ? Number(r.variant_id) : r.product_id,
        sku: r.base_sku || r.product_name,
        productName: r.product_name,
        suggestedOrderQty,
        suggestedOrderPieces: suggestedOrderQty * orderUomUnits,
        orderUomUnits,
        onOrderPieces,
        openPoCount: Number(r.open_po_count),
        status,
        preferredVendorId: preferredVendor?.vendorId ?? null,
      });
    }

    // Group by vendor
    const vendorGroups = new Map<number | null, typeof eligibleItems>();
    for (const item of eligibleItems) {
      const key = item.preferredVendorId;
      if (!vendorGroups.has(key)) vendorGroups.set(key, []);
      vendorGroups.get(key)!.push(item);
    }

    const today = new Date().toISOString().split("T")[0];

    // Process each vendor group
    for (const [vendorId, items] of vendorGroups) {
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
            const preferredVendorProduct = null; // Could look up cost
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
              unitCostCents: 0,
              lineTotalCents: 0,
              status: "open",
            };
          });

        if (newLines.length > 0) {
          await storage.bulkCreatePurchaseOrderLines(newLines as any);
          linesAdded += newLines.length;
        }
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
          unitCostCents: 0,
          lineTotalCents: 0,
          status: "open",
        }));

        if (lineData.length > 0) {
          await storage.bulkCreatePurchaseOrderLines(lineData as any);
          linesAdded += lineData.length;
        }
      }

      // Recalculate totals
      await purchasing.recalculateTotals(poId);
    }

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
      finishedAt: new Date(),
    });
    throw error;
  }
}
