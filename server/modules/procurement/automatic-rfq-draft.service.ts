import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  auditEvents as auditEventsTable,
  purchaseRecommendationLines as purchaseRecommendationLinesTable,
  requestForQuoteLines as requestForQuoteLinesTable,
  requestForQuotes as requestForQuotesTable,
  vendorProducts as vendorProductsTable,
  vendors as vendorsTable,
} from "@shared/schema";
import {
  lockAndLoadActiveRfqAllocations,
  purchasingSkuAllocationKey,
} from "./purchasing-rfq.service";

export type AutomaticRfqDraftPolicy = {
  mode: "manual" | "preferred_vendor";
  minimumConfidence: "high" | "medium";
  requireTrustedForecast: boolean;
  maximumLinesPerRun: number;
};

export type AutomaticRfqRecommendationLine = {
  id: number;
  runId: number;
  productId: number;
  productVariantId: number | null;
  warehouseId: number | null;
  sku: string;
  recommendedPieces: number;
  preferredVendorId: number | null;
  preferredVendorProductId: number | null;
  status: string;
  evidenceSnapshot: Record<string, any>;
};

export type AutomaticRfqDraftSkipCode =
  | "automation_disabled"
  | "no_preferred_supplier"
  | "po_ready"
  | "supplier_quote_current"
  | "confidence_below_policy"
  | "forecast_review_required"
  | "non_supplier_blocker"
  | "recommendation_changed"
  | "inactive_supplier_catalog"
  | "already_allocated"
  | "run_limit";

export type AutomaticRfqDraftSkip = {
  recommendationLineId: number;
  sku: string;
  code: AutomaticRfqDraftSkipCode;
  detail: string;
};

export type AutomaticRfqDraftResult = {
  rfqs: any[];
  lines: any[];
  skipped: AutomaticRfqDraftSkip[];
  reused: boolean;
};

type ResolvedAutomaticRfqLine = AutomaticRfqRecommendationLine & { requestedPieces: number };

export function normalizeAutomaticRfqDraftPolicy(settings: Record<string, any>): AutomaticRfqDraftPolicy {
  return {
    mode: settings.rfqDraftAutomationMode === "preferred_vendor" ? "preferred_vendor" : "manual",
    minimumConfidence: settings.rfqDraftMinimumConfidence === "medium" ? "medium" : "high",
    requireTrustedForecast: settings.rfqDraftRequireTrustedForecast !== false,
    maximumLinesPerRun: Number.isSafeInteger(settings.rfqDraftMaximumLinesPerRun)
      ? Math.min(500, Math.max(1, settings.rfqDraftMaximumLinesPerRun))
      : 100,
  };
}

export function planAutomaticRfqDrafts(
  lines: AutomaticRfqRecommendationLine[],
  policy: AutomaticRfqDraftPolicy,
): { selected: AutomaticRfqRecommendationLine[]; skipped: AutomaticRfqDraftSkip[] } {
  const selected: AutomaticRfqRecommendationLine[] = [];
  const skipped: AutomaticRfqDraftSkip[] = [];
  const skip = (line: AutomaticRfqRecommendationLine, code: AutomaticRfqDraftSkipCode, detail: string) =>
    skipped.push({ recommendationLineId: line.id, sku: line.sku, code, detail });

  for (const line of lines) {
    if (line.status !== "open") continue;
    if (policy.mode === "manual") {
      skip(line, "automation_disabled", "RFQ draft automation is configured for manual selection.");
      continue;
    }
    if (!line.preferredVendorId || !line.preferredVendorProductId) {
      skip(line, "no_preferred_supplier", "No preferred supplier catalog identity was present in the recommendation snapshot.");
      continue;
    }
    const evidence = line.evidenceSnapshot ?? {};
    if (evidence.qualityGate?.autoDraftEligible === true) {
      skip(line, "po_ready", "The recommendation already has the supplier and usable quote needed for PO automation.");
      continue;
    }
    const supplierBasis = evidence.supplierBasis ?? {};
    const supplierQuoteNeedsWork = supplierBasis.costQuality !== "current"
      || supplierBasis.costSource === "last_purchase_cost"
      || supplierBasis.pricingBasis === "legacy_unknown";
    if (!supplierQuoteNeedsWork) {
      skip(line, "supplier_quote_current", "The preferred supplier already has a current usable quote; RFQ automation is not needed.");
      continue;
    }
    const confidence = String(evidence.rfqConfidence ?? evidence.confidence ?? "low");
    if (confidence !== "high" && !(policy.minimumConfidence === "medium" && confidence === "medium")) {
      skip(line, "confidence_below_policy", `Recommendation confidence ${confidence} is below the RFQ automation policy.`);
      continue;
    }
    if (policy.requireTrustedForecast && evidence.forecastTrust?.severity !== "ok") {
      skip(line, "forecast_review_required", "Forecast trust is not clean enough for unattended RFQ drafting.");
      continue;
    }
    const blockers = Array.isArray(evidence.autopilotBlockers) ? evidence.autopilotBlockers : [];
    const nonSupplierBlocker = blockers.find((blocker: any) =>
      !["supplier_cost", "supplier_catalog"].includes(String(blocker?.area ?? "")));
    if (nonSupplierBlocker) {
      skip(line, "non_supplier_blocker", `Blocked by ${nonSupplierBlocker.label ?? nonSupplierBlocker.code ?? nonSupplierBlocker.area}.`);
      continue;
    }
    if (selected.length >= policy.maximumLinesPerRun) {
      skip(line, "run_limit", `The ${policy.maximumLinesPerRun}-line automatic RFQ run limit was reached.`);
      continue;
    }
    selected.push(line);
  }
  return { selected, skipped };
}

export function summarizeAutomaticRfqDraftResult(policy: AutomaticRfqDraftPolicy, result: AutomaticRfqDraftResult) {
  const skippedByCode: Record<string, number> = {};
  for (const skip of result.skipped) skippedByCode[skip.code] = (skippedByCode[skip.code] ?? 0) + 1;
  return {
    mode: policy.mode,
    rfqCount: result.rfqs.length,
    lineCount: result.lines.length,
    skippedCount: result.skipped.length,
    skippedByCode,
    reused: result.reused,
  };
}

export function createAutomaticRfqDraftService(database: any) {
  async function createDrafts(input: {
    recommendationRunId: number;
    lines: AutomaticRfqRecommendationLine[];
    policy: AutomaticRfqDraftPolicy;
    actorId: string;
  }): Promise<AutomaticRfqDraftResult> {
    const plan = planAutomaticRfqDrafts(input.lines, input.policy);
    if (plan.selected.length === 0) return { rfqs: [], lines: [], skipped: plan.skipped, reused: false };

    return database.transaction(async (tx: any) => {
      const recommendationIds = plan.selected.map((line) => line.id).sort((left, right) => left - right);
      const persistedRows = await tx.select().from(purchaseRecommendationLinesTable).where(and(
        eq(purchaseRecommendationLinesTable.runId, input.recommendationRunId),
        inArray(purchaseRecommendationLinesTable.id, recommendationIds),
      )).orderBy(purchaseRecommendationLinesTable.id).for("update");
      const persistedById = new Map(persistedRows.map((line: any) => [Number(line.id), line]));
      const skipped = [...plan.skipped];
      const current = plan.selected.flatMap((line) => {
        const persisted = persistedById.get(line.id) as any;
        const unchanged = Boolean(persisted
          && persisted.status === "open"
          && Number(persisted.productId) === line.productId
          && (persisted.productVariantId ?? null) === line.productVariantId
          && (persisted.warehouseId ?? null) === line.warehouseId
          && Number(persisted.preferredVendorId) === Number(line.preferredVendorId)
          && Number(persisted.preferredVendorProductId) === Number(line.preferredVendorProductId));
        if (!unchanged) {
          skipped.push({
            recommendationLineId: line.id,
            sku: line.sku,
            code: "recommendation_changed",
            detail: "The durable recommendation identity changed before the automatic RFQ transaction acquired its lock.",
          });
          return [];
        }
        return [{ ...line, ...persisted, evidenceSnapshot: persisted.evidenceSnapshot ?? {} } as AutomaticRfqRecommendationLine];
      });

      const idempotencyKey = `auto-rfq-recommendation-run:${input.recommendationRunId}`;
      const candidatesByVendor = new Map<number, AutomaticRfqRecommendationLine[]>();
      for (const line of current) {
        const vendorId = Number(line.preferredVendorId);
        const group = candidatesByVendor.get(vendorId) ?? [];
        group.push(line);
        candidatesByVendor.set(vendorId, group);
      }

      const createdRfqs: any[] = [];
      const createdLines: any[] = [];
      let reused = false;
      for (const vendorId of Array.from(candidatesByVendor.keys())) {
        const existing = await tx.select().from(requestForQuotesTable).where(and(
          eq(requestForQuotesTable.vendorId, vendorId),
          eq(requestForQuotesTable.idempotencyKey, idempotencyKey),
        )).limit(1).for("update");
        if (!existing[0]) continue;
        reused = true;
        createdRfqs.push(existing[0]);
        const existingLines = await tx.select().from(requestForQuoteLinesTable)
          .where(eq(requestForQuoteLinesTable.rfqId, existing[0].id));
        createdLines.push(...existingLines);
        candidatesByVendor.delete(vendorId);
      }

      const pending = Array.from(candidatesByVendor.values()).flat();
      if (pending.length === 0) return { rfqs: createdRfqs, lines: createdLines, skipped, reused };

      const vendorIds = Array.from(candidatesByVendor.keys()).sort((left, right) => left - right);
      const vendors = await tx.select().from(vendorsTable).where(inArray(vendorsTable.id, vendorIds))
        .orderBy(vendorsTable.id).for("update");
      const activeVendorById = new Map(vendors
        .filter((vendor: any) => Number(vendor.active) === 1)
        .map((vendor: any) => [Number(vendor.id), vendor]));

      const allocatedBySku = await lockAndLoadActiveRfqAllocations(tx, pending);
      const vendorProductIds = Array.from(new Set<number>(pending.map((line) => Number(line.preferredVendorProductId))))
        .sort((left, right) => left - right);
      const mappings = await tx.select().from(vendorProductsTable)
        .where(inArray(vendorProductsTable.id, vendorProductIds))
        .orderBy(vendorProductsTable.id).for("update");
      const mappingById = new Map(mappings
        .filter((mapping: any) => Number(mapping.isActive) === 1)
        .map((mapping: any) => [Number(mapping.id), mapping]));

      const resolvedByVendor = new Map<number, ResolvedAutomaticRfqLine[]>();
      for (const line of pending) {
        const vendorId = Number(line.preferredVendorId);
        const mapping = mappingById.get(Number(line.preferredVendorProductId)) as any;
        const supplierIdentityIsActive = Boolean(activeVendorById.get(vendorId) && mapping
          && Number(mapping.vendorId) === vendorId
          && Number(mapping.productId) === Number(line.productId)
          && (mapping.productVariantId ?? null) === (line.productVariantId ?? null));
        if (!supplierIdentityIsActive) {
          skipped.push({
            recommendationLineId: line.id,
            sku: line.sku,
            code: "inactive_supplier_catalog",
            detail: "The preferred supplier or exact supplier catalog mapping is inactive or changed.",
          });
          continue;
        }

        const allocationKey = purchasingSkuAllocationKey(line);
        const alreadyAllocated = allocatedBySku.get(allocationKey) ?? 0;
        const remainingPieces = Math.max(Number(line.recommendedPieces) - alreadyAllocated, 0);
        if (remainingPieces === 0) {
          skipped.push({
            recommendationLineId: line.id,
            sku: line.sku,
            code: "already_allocated",
            detail: "Active RFQs from this or an earlier recommendation run already cover the recommended quantity.",
          });
          continue;
        }
        allocatedBySku.set(allocationKey, alreadyAllocated + remainingPieces);
        const group = resolvedByVendor.get(vendorId) ?? [];
        group.push({ ...line, requestedPieces: remainingPieces });
        resolvedByVendor.set(vendorId, group);
      }

      const auditRows: any[] = [];
      for (const [vendorId, lines] of resolvedByVendor.entries()) {
        const vendor = activeVendorById.get(vendorId) as any;
        const insertedRfqs = await tx.insert(requestForQuotesTable).values({
          rfqNumber: `RFQ-AUTO-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`,
          vendorId,
          idempotencyKey,
          status: "draft",
          requestNote: `Automatically prepared from purchase recommendation run ${input.recommendationRunId}. Review before sending.`,
          currency: String(vendor?.currency ?? "USD").toUpperCase(),
          createdBy: input.actorId,
        }).returning();
        const rfq = insertedRfqs[0];
        if (!rfq) throw new Error("Automatic RFQ header was not created");
        createdRfqs.push(rfq);

        for (const line of lines) {
          const mapping = mappingById.get(Number(line.preferredVendorProductId)) as any;
          const insertedLines = await tx.insert(requestForQuoteLinesTable).values({
            rfqId: rfq.id,
            recommendationLineId: line.id,
            vendorProductId: Number(line.preferredVendorProductId),
            requestedPieces: line.requestedPieces,
            purchaseUom: mapping?.purchaseUom ?? null,
            piecesPerPurchaseUom: mapping?.piecesPerPurchaseUom ?? null,
            requestedPurchaseUomQty: mapping?.piecesPerPurchaseUom
              ? String(line.requestedPieces / Number(mapping.piecesPerPurchaseUom))
              : null,
            status: "draft",
            quantityOverrideReason: line.requestedPieces === Number(line.recommendedPieces)
              ? null
              : "Automatically reduced by active RFQ allocations from prior recommendation runs.",
          }).returning();
          if (!insertedLines[0]) throw new Error("Automatic RFQ line was not created");
          createdLines.push(insertedLines[0]);
        }
        auditRows.push({
          level: "AUDIT",
          actor: input.actorId.startsWith("system:") ? input.actorId : `user:${input.actorId}`,
          action: "purchase_rfq.automatic_draft_created",
          target: `request_for_quote:${rfq.id}`,
          changes: { after: { rfqNumber: rfq.rfqNumber, vendorId, lineCount: lines.length, status: "draft" } },
          context: { recommendationRunId: input.recommendationRunId, idempotencyKey },
        });
      }
      if (auditRows.length > 0) await tx.insert(auditEventsTable).values(auditRows);
      return { rfqs: createdRfqs, lines: createdLines, skipped, reused };
    });
  }

  return { createDrafts };
}
