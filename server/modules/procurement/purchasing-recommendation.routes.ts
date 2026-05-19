import type { Express } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { requirePermission } from "../../routes/middleware";
import { procurementStorage } from "../procurement";
import { inventoryStorage } from "../inventory";
import {
  generatePurchasingRecommendations,
  passesAutoDraftApprovalPolicy,
  type AutoDraftRecommendationSettings,
  type PurchasingRecommendationDefaults,
  type PurchasingRecommendationExclusionRule,
  type PurchasingRecommendationProductMeta,
  type PurchasingRecommendationRawRow,
} from "./purchasing-recommendation.engine";
import {
  buildPurchasingRecommendationRunDetail,
  type PurchasingRecommendationRunPoMutation,
} from "./purchasing-recommendation.run-detail";
const storage = { ...procurementStorage, ...inventoryStorage };

function shouldCreateDraftPos(settings: AutoDraftRecommendationSettings): boolean {
  return settings.autoDraftMode !== "review_only";
}

function parseRunHistoryLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 10;
  return Math.min(parsed, 50);
}

function parseSummaryJson(value: unknown): any {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

function numberField(row: any, camel: string, snake: string): number {
  return Number(row?.[camel] ?? row?.[snake] ?? 0) || 0;
}

function normalizeAutoDraftRun(row: any) {
  const summaryJson = parseSummaryJson(row?.summaryJson ?? row?.summary_json);
  const actionableRecommendations = Array.isArray(summaryJson?.actionableRecommendations)
    ? summaryJson.actionableRecommendations
    : [];
  const skippedRecommendations = Array.isArray(summaryJson?.skippedRecommendations)
    ? summaryJson.skippedRecommendations
    : [];
  const poMutations = Array.isArray(summaryJson?.poMutations)
    ? summaryJson.poMutations
    : [];

  return {
    id: Number(row?.id),
    runAt: row?.runAt ?? row?.run_at,
    triggeredBy: row?.triggeredBy ?? row?.triggered_by ?? null,
    triggeredByUser: row?.triggeredByUser ?? row?.triggered_by_user ?? null,
    status: row?.status,
    itemsAnalyzed: numberField(row, "itemsAnalyzed", "items_analyzed"),
    posCreated: numberField(row, "posCreated", "pos_created"),
    posUpdated: numberField(row, "posUpdated", "pos_updated"),
    linesAdded: numberField(row, "linesAdded", "lines_added"),
    skippedNoVendor: numberField(row, "skippedNoVendor", "skipped_no_vendor"),
    skippedOnOrder: numberField(row, "skippedOnOrder", "skipped_on_order"),
    skippedExcluded: numberField(row, "skippedExcluded", "skipped_excluded"),
    errorMessage: row?.errorMessage ?? row?.error_message ?? null,
    finishedAt: row?.finishedAt ?? row?.finished_at ?? null,
    mode: summaryJson?.settings?.autoDraftMode === "review_only" ? "review_only" : "draft_po",
    approvalPolicy: summaryJson?.settings?.approvalPolicy === "high_confidence_only"
      ? "high_confidence_only"
      : "high_confidence_only",
    actionableCount: Number(summaryJson?.recommendationSummary?.actionableCount ?? numberField(row, "linesAdded", "lines_added")) || 0,
    autoDraftEligibleCount:
      Number(summaryJson?.recommendationSummary?.autoDraftEligibleCount ?? numberField(row, "linesAdded", "lines_added")) || 0,
    autoDraftReviewRequiredCount:
      Number(summaryJson?.recommendationSummary?.autoDraftReviewRequiredCount ?? 0) || 0,
    forecastDiagnostics: summaryJson?.forecastDiagnostics ?? null,
    poMutationCount: poMutations.length,
    topActionableRecommendation: actionableRecommendations[0] ?? null,
    topSkippedRecommendation: skippedRecommendations[0] ?? null,
  };
}

async function loadPurchasingRecommendationDefaults(): Promise<PurchasingRecommendationDefaults> {
  const defaultsQuery = await db.execute(sql`
    SELECT key, value FROM warehouse.echelon_settings
    WHERE key IN ('default_lead_time_days','default_safety_stock_days')
  `);
  const defaultsMap = new Map<string, string>();
  for (const row of defaultsQuery.rows as any[]) defaultsMap.set(row.key, row.value);

  return {
    leadTimeDays: Number.parseInt(defaultsMap.get("default_lead_time_days") ?? "14", 10) || 14,
    safetyStockDays: Number.parseInt(defaultsMap.get("default_safety_stock_days") ?? "7", 10) || 7,
  };
}

async function loadPurchasingRecommendationContext(): Promise<{
  defaults: PurchasingRecommendationDefaults;
  rules: PurchasingRecommendationExclusionRule[];
  productMetaById: Map<number, PurchasingRecommendationProductMeta>;
}> {
  const { products: productsTable, reorderExclusionRules: exclRules } = await import("../../storage/base");
  const [defaults, rules, metaRows] = await Promise.all([
    loadPurchasingRecommendationDefaults(),
    db.select().from(exclRules),
    db.execute(sql`
      SELECT id, category, brand, product_type, sku, tags, reorder_excluded
      FROM ${productsTable}
      WHERE is_active = true
    `),
  ]);

  const productMetaById = new Map<number, PurchasingRecommendationProductMeta>();
  for (const row of metaRows.rows as any[]) {
    productMetaById.set(Number(row.id), row);
  }

  return {
    defaults,
    rules: rules as PurchasingRecommendationExclusionRule[],
    productMetaById,
  };
}

export function registerPurchasingRecommendationRoutes(app: Express) {
  // ── Purchasing / Reorder Analysis ──────────────────────────────────
  app.get("/api/purchasing/kpis", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const configuredLookback = await storage.getVelocityLookbackDays();
      const rawRows = await storage.getReorderAnalysisData(configuredLookback);
      const context = await loadPurchasingRecommendationContext();
      const recommendationResult = generatePurchasingRecommendations({
        rows: rawRows as PurchasingRecommendationRawRow[],
        lookbackDays: configuredLookback,
        ...context,
      });

      let criticalRestocks = 0;
      let upcomingRestocks = 0;
      let idleCapitalCents = 0;

      for (const item of recommendationResult.items) {
        const effectiveSupply = item.currentSupply.effectiveSupplyPieces;
        const avgDailyUsage = item.demandBasis.avgDailyUsagePieces;
        const costCents = item.estimatedCostCents ?? 0;

        if (effectiveSupply < item.reorderPoint) {
          criticalRestocks++;
        } else if (effectiveSupply < item.reorderPoint + 14 * avgDailyUsage && avgDailyUsage > 0) {
          upcomingRestocks++;
        }

        if (item.daysOfSupply > 180 && item.totalOnHand > 0) {
          idleCapitalCents += item.totalOnHand * costCents;
        }
      }

      // Pipeline Value Calculation
      const openPoSummary = await storage.getOpenPoSummaryReport();
      let inboundPipelineValueCents = 0;
      let totalOpenLines = 0;
      openPoSummary.forEach((po) => {
        if (['approved', 'sent', 'acknowledged', 'partially_received'].includes(po.status)) {
          inboundPipelineValueCents += Number(po.total_value_cents) || 0;
          totalOpenLines += Number(po.total_lines) || 0;
        }
      });

      res.json({
        criticalRestocks,
        upcomingRestocks,
        idleCapitalCents,
        inboundPipelineValueCents,
        totalOpenLines,
        lastComputedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error("Error fetching purchasing dashboard KPIs:", error);
      res.status(500).json({ error: "Failed to fetch purchasing dashboard KPIs" });
    }
  });

  app.post("/api/purchasing/auto-draft-run", requirePermission("inventory", "adjust"), async (req, res) => {
    let runRecord: any | null = null;
    try {
      const { purchasing } = app.locals.services;
      const userId = (req as any).user?.id ?? req.session?.user?.id ?? "SYSTEM";
      runRecord = await storage.createAutoDraftRun({
        triggeredBy: "manual",
        triggeredByUser: userId,
        status: "running",
      });
      const configuredLookback = await storage.getVelocityLookbackDays();
      const rawRows = await storage.getReorderAnalysisData(configuredLookback);
      const settings = (await storage.getAutoDraftSettings()) as AutoDraftRecommendationSettings;
      const context = await loadPurchasingRecommendationContext();
      const recommendationResult = generatePurchasingRecommendations({
        rows: rawRows as PurchasingRecommendationRawRow[],
        lookbackDays: configuredLookback,
        autoDraftSettings: settings,
        requireVendor: Boolean(settings.skipNoVendor),
        ...context,
      });

      const itemsToOrder = recommendationResult.items
        .filter((item) => passesAutoDraftApprovalPolicy(item, settings))
        .map((item) => ({
          productId: item.productId,
          productVariantId: item.productVariantId ?? item.productId,
          suggestedQty: item.suggestedOrderQty,
          vendorId: item.preferredVendorId ?? undefined,
        }));

      let result: any[] = [];
      const poMutations: PurchasingRecommendationRunPoMutation[] = [];
      const createDraftPos = shouldCreateDraftPos(settings);
      if (createDraftPos && itemsToOrder.length > 0) {
        result = await purchasing.createPOFromReorder(itemsToOrder, userId);
        for (const po of result) {
          if (po?.vendorId && po?.id) {
            poMutations.push({
              vendorId: Number(po.vendorId),
              poId: Number(po.id),
              action: "upserted",
              linesAdded: 0,
            });
          }
        }
      }

      const runDetail = buildPurchasingRecommendationRunDetail(recommendationResult, {
        lookbackDays: configuredLookback,
        settings,
        poMutations,
      });

      await storage.updateAutoDraftRun(runRecord.id, {
        status: "success",
        itemsAnalyzed: rawRows.length,
        posCreated: result.length,
        posUpdated: 0,
        linesAdded: createDraftPos ? itemsToOrder.length : 0,
        skippedNoVendor: recommendationResult.summary.skippedNoVendor,
        skippedOnOrder: recommendationResult.summary.skippedOnOrder,
        skippedExcluded: recommendationResult.summary.excludedCount,
        summaryJson: runDetail,
        finishedAt: new Date(),
      });

      res.json({
        success: true,
        pos: result,
        count: result.length,
        itemsDrafted: createDraftPos ? itemsToOrder.length : 0,
        reviewOnly: !createDraftPos,
        recommendationSummary: recommendationResult.summary,
        recommendationRun: {
          id: runRecord.id,
          detail: runDetail,
        },
      });
    } catch (error: any) {
      if (runRecord?.id) {
        await storage.updateAutoDraftRun(runRecord.id, {
          status: "error",
          errorMessage: error?.message || "Unknown error",
          finishedAt: new Date(),
        });
      }
      console.error("Error running auto-draft:", error);
      res.status(500).json({ error: "Failed to run auto-draft" });
    }
  });

  // ── Purchasing / Reorder Analysis ──────────────────────────────────
  app.get("/api/purchasing/reorder-analysis", requirePermission("inventory", "view"), async (req, res) => {
    try {
      // Use velocity_lookback_days from warehouse_settings as the default lookback
      const configuredLookback = await storage.getVelocityLookbackDays();
      const lookbackDays = parseInt(req.query.lookbackDays as string) || configuredLookback;

      // Product-level query: aggregate inventory and velocity in base units (pieces)
      // Also fetch the highest-level variant (ordering UOM) for rounding order quantities
      const rawRows = await storage.getReorderAnalysisData(lookbackDays);
      const context = await loadPurchasingRecommendationContext();
      const recommendationResult = generatePurchasingRecommendations({
        rows: rawRows as PurchasingRecommendationRawRow[],
        lookbackDays,
        ...context,
      });

      res.json({
        items: recommendationResult.items,
        summary: recommendationResult.summary,
        skippedItems: recommendationResult.skippedItems,
        lookbackDays,
      });
    } catch (error) {
      console.error("Error fetching reorder analysis:", error);
      res.status(500).json({ error: "Failed to fetch reorder analysis" });
    }
  });

  // PATCH velocity lookback days
  app.patch("/api/purchasing/velocity-lookback", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const days = parseInt(req.body.days);
      if (!days || days < 7 || days > 365) {
        return res.status(400).json({ error: "Days must be between 7 and 365" });
      }
      await storage.updateVelocityLookbackDays(days);
      res.json({ ok: true, days });
    } catch (error) {
      console.error("Error updating velocity lookback:", error);
      res.status(500).json({ error: "Failed to update velocity lookback" });
    }
  });

}

export function registerPurchasingRecommendationAdminRoutes(app: Express) {
  // ===== PURCHASING DASHBOARD ROUTES =====

  // GET /api/purchasing/dashboard
  app.get("/api/purchasing/dashboard", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const configuredLookback = await storage.getVelocityLookbackDays();
      const lookbackDays = parseInt(req.query.lookbackDays as string) || configuredLookback;
      const data = await storage.getDashboardData(lookbackDays);
      res.json(data);
    } catch (error) {
      console.error("Error fetching purchasing dashboard:", error);
      res.status(500).json({ error: "Failed to fetch dashboard data" });
    }
  });

  // GET /api/purchasing/exclusion-rules
  app.get("/api/purchasing/exclusion-rules", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const rules = await storage.getReorderExclusionRules();
      const totalExcluded = await storage.getTotalExcludedProducts();

      // Get match counts for each rule
      const rulesWithCounts = await Promise.all(
        rules.map(async (r: any) => ({
          ...r,
          matchCount: await storage.getExclusionRuleMatchCount(r.field, r.value),
        }))
      );

      res.json({ rules: rulesWithCounts, totalExcluded });
    } catch (error) {
      console.error("Error fetching exclusion rules:", error);
      res.status(500).json({ error: "Failed to fetch exclusion rules" });
    }
  });

  // POST /api/purchasing/exclusion-rules
  app.post("/api/purchasing/exclusion-rules", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { field, value } = req.body;
      const validFields = ["category", "brand", "product_type", "sku_prefix", "sku_exact", "tag"];
      if (!field || !validFields.includes(field)) {
        return res.status(400).json({ error: `field must be one of: ${validFields.join(", ")}` });
      }
      if (!value || typeof value !== "string" || value.trim().length === 0) {
        return res.status(400).json({ error: "value is required" });
      }

      const userId = (req as any).user?.id ?? req.session.user?.id;
      const rule = await storage.createReorderExclusionRule({
        field,
        value: value.trim(),
        createdBy: userId,
      });
      const matchCount = await storage.getExclusionRuleMatchCount(rule.field, rule.value);
      res.status(201).json({ ...rule, matchCount });
    } catch (error: any) {
      if (error?.message?.includes("unique") || error?.code === "23505") {
        return res.status(409).json({ error: "Rule already exists" });
      }
      console.error("Error creating exclusion rule:", error);
      res.status(500).json({ error: "Failed to create exclusion rule" });
    }
  });

  // DELETE /api/purchasing/exclusion-rules/:id
  app.delete("/api/purchasing/exclusion-rules/:id", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deleted = await storage.deleteReorderExclusionRule(id);
      if (!deleted) {
        return res.status(404).json({ error: "Rule not found" });
      }
      res.json({ ok: true });
    } catch (error) {
      console.error("Error deleting exclusion rule:", error);
      res.status(500).json({ error: "Failed to delete exclusion rule" });
    }
  });

  // GET /api/purchasing/exclusion-rules/field-values?field=category
  // Returns distinct values for a given field from products table
  app.get("/api/purchasing/exclusion-rules/field-values", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { db } = await import("../../db");
      const field = String(req.query.field || "").trim();
      const allowedFields: Record<string, string | null> = {
        category: "category",
        brand: "brand",
        product_type: "product_type",
        tag: null, // handled separately — tags is jsonb array
      };
      if (!field || !(field in allowedFields)) {
        return res.status(400).json({ error: "Invalid field. Must be one of: category, brand, product_type, tag" });
      }
      let values: string[] = [];
      if (field === "tag") {
        // Unnest tags jsonb array
        const rows = await db.execute(sql`
          SELECT DISTINCT trim(tag::text, '"') AS value
          FROM catalog.products, jsonb_array_elements_text(tags) AS tag
          WHERE tags IS NOT NULL AND jsonb_array_length(tags) > 0
          ORDER BY value
        `);
        values = (rows.rows as any[]).map(r => r.value).filter(Boolean);
      } else {
        const col = allowedFields[field]!;
        const rows = await db.execute(sql`
          SELECT DISTINCT ${sql.raw(col)} AS value
          FROM catalog.products
          WHERE is_active = true AND ${sql.raw(col)} IS NOT NULL AND ${sql.raw(col)} != ''
          ORDER BY value
        `);
        values = (rows.rows as any[]).map(r => r.value).filter(Boolean);
      }
      res.json({ field, values });
    } catch (error: any) {
      console.error("Error fetching field values:", error);
      res.status(500).json({ error: "Failed to fetch field values" });
    }
  });

  // PATCH /api/purchasing/products/:productId/reorder-excluded
  app.patch("/api/purchasing/products/:productId/reorder-excluded", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const productId = parseInt(req.params.productId);
      const { excluded } = req.body;
      if (typeof excluded !== "boolean") {
        return res.status(400).json({ error: "excluded must be a boolean" });
      }
      await storage.setProductReorderExcluded(productId, excluded);
      res.json({ ok: true });
    } catch (error) {
      console.error("Error toggling product exclusion:", error);
      res.status(500).json({ error: "Failed to update product exclusion" });
    }
  });

  // GET /api/purchasing/auto-draft/status
  app.get("/api/purchasing/auto-draft/status", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const run = await storage.getLatestAutoDraftRun();
      res.json(run || null);
    } catch (error) {
      console.error("Error fetching auto-draft status:", error);
      res.status(500).json({ error: "Failed to fetch auto-draft status" });
    }
  });

  // GET /api/purchasing/auto-draft/runs
  app.get("/api/purchasing/auto-draft/runs", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const limit = parseRunHistoryLimit(req.query.limit);
      const runs = await storage.getRecentAutoDraftRuns(limit);
      res.json({
        limit,
        runs: runs.map(normalizeAutoDraftRun),
      });
    } catch (error) {
      console.error("Error fetching auto-draft run history:", error);
      res.status(500).json({ error: "Failed to fetch auto-draft run history" });
    }
  });

  // POST /api/purchasing/auto-draft/run
  app.post("/api/purchasing/auto-draft/run", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const user = (req as any).user ?? req.session.user;
      if (user?.role !== "admin") {
        return res.status(403).json({ error: "Admin role required" });
      }

      // Import and run the job asynchronously
      const { runAutoDraftJob } = await import("../../jobs/auto-draft.job");
      runAutoDraftJob({ triggeredBy: "manual", triggeredByUser: user?.id })
        .catch((err: any) => console.error("[Auto-draft] manual run failed:", err));

      res.status(202).json({ message: "Auto-draft job started" });
    } catch (error) {
      console.error("Error triggering auto-draft:", error);
      res.status(500).json({ error: "Failed to trigger auto-draft" });
    }
  });

  // GET /api/purchasing/auto-draft-settings
  app.get("/api/purchasing/auto-draft-settings", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const settings = await storage.getAutoDraftSettings();
      res.json(settings);
    } catch (error) {
      console.error("Error fetching auto-draft settings:", error);
      res.status(500).json({ error: "Failed to fetch settings" });
    }
  });

  // PATCH /api/purchasing/auto-draft-settings
  app.patch("/api/purchasing/auto-draft-settings", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { autoDraftMode, approvalPolicy, includeOrderSoon, skipOnOpenPo, skipNoVendor } = req.body;
      if (autoDraftMode !== undefined && !["draft_po", "review_only"].includes(autoDraftMode)) {
        return res.status(400).json({ error: "autoDraftMode must be one of: draft_po, review_only" });
      }
      if (approvalPolicy !== undefined && approvalPolicy !== "high_confidence_only") {
        return res.status(400).json({ error: "approvalPolicy must be high_confidence_only" });
      }
      await storage.updateAutoDraftSettings(undefined, {
        autoDraftMode,
        approvalPolicy,
        includeOrderSoon,
        skipOnOpenPo,
        skipNoVendor,
      });
      res.json({ ok: true });
    } catch (error) {
      console.error("Error updating auto-draft settings:", error);
      res.status(500).json({ error: "Failed to update settings" });
    }
  });
}
