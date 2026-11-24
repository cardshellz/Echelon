import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { readIntegerCents } from "@shared/money-read";
import type { RfqCreatePayload } from "@shared/procurement/rfq-create-command";
import type { SupplierPriceList } from "@shared/procurement/supplier-sourcing";
import {
  purchaseRecommendationLines as purchaseRecommendationLinesTable,
  requestForQuoteLines as requestForQuoteLinesTable,
  requestForQuotes as requestForQuotesTable,
  vendorProducts as vendorProductsTable,
  vendors as vendorsTable,
} from "@shared/schema";
import { centsToMills, millsToCents } from "@shared/utils/money";
import { insertAuditEventDrizzle } from "../../../infrastructure/transactional-audit";
import {
  createPurchaseRecommendationSnapshotService,
  type CreatePurchaseRecommendationRunInput,
} from "../application/purchase-recommendation-snapshot.service";
import {
  lockAndLoadActiveRfqAllocations,
  purchasingSkuAllocationKey,
} from "../application/purchasing-rfq.service";
import {
  buildRfqCreationRequestHash,
  evaluateRfqAllocationOverride,
} from "../application/purchasing-rfq-allocation";
import type { RfqWorkflowTransaction } from "../application/rfq-workflow.service";
import { loadSupplierSourcingRecords } from "../infrastructure/supplier-sourcing.repository";
import type { PurchasingCatalog } from "./purchasing-catalog";
import {
  assertOptionalCatalogText,
  assertPositivePgInteger,
  PurchasingError,
  rethrowVendorCatalogWriteError,
  type CreateRfqBatchLineInput,
  type PreloadLine,
  type PreparedRfqBatchLineInput,
  type PurchasingBaseContext,
} from "./purchasing.types";

export function createPurchasingRfqAndPreload(
  ctx: PurchasingBaseContext,
  catalog: Pick<
    PurchasingCatalog,
    | "lockVendorProductReferences"
    | "demoteCompetingPreferredMappings"
    | "appendPreferredDemotionAudits"
    | "catalogAuditSnapshot"
  >,
) {
  const { db, storage, now, readCommandActor, lockInventoryCostGraph, resolveActor } = ctx;
  const {
    lockVendorProductReferences,
    demoteCompetingPreferredMappings,
    appendPreferredDemotionAudits,
    catalogAuditSnapshot,
  } = catalog;

  async function snapshotPurchaseRecommendations(
    input: CreatePurchaseRecommendationRunInput,
    userId?: string | null,
  ) {
    try {
      return await createPurchaseRecommendationSnapshotService(db).createRun(input, userId);
    } catch (error: any) {
      if (error instanceof RangeError) {
        throw new PurchasingError(error.message, 400, { code: "PURCHASE_RECOMMENDATION_RUN_INVALID" });
      }
      throw error;
    }
  }

  async function createRfqBatch(input: {
    idempotencyKey: string;
    requestNote?: string | null;
    responseDueDate?: string | null;
    lines: CreateRfqBatchLineInput[];
  }, userId?: string | null, existingTransaction?: RfqWorkflowTransaction): Promise<{ rfqs: any[]; lines: any[]; reused: boolean }> {
    const idempotencyKey = input.idempotencyKey?.trim();
    if (!idempotencyKey || idempotencyKey.length > 160) {
      throw new PurchasingError("idempotencyKey is required and cannot exceed 160 characters", 400);
    }
    assertOptionalCatalogText(input.requestNote, "requestNote", 20_000);
    if (input.responseDueDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(input.responseDueDate)) {
      throw new PurchasingError("responseDueDate must use YYYY-MM-DD format", 400);
    }
    if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 500) {
      throw new PurchasingError("lines must contain between 1 and 500 selections", 400);
    }
    const duplicateKeys = new Set<string>();
    for (const [index, line] of input.lines.entries()) {
      assertPositivePgInteger(line.recommendationLineId, `lines[${index}].recommendationLineId`);
      assertPositivePgInteger(line.vendorId, `lines[${index}].vendorId`);
      if (line.vendorProductId !== undefined) assertPositivePgInteger(line.vendorProductId, `lines[${index}].vendorProductId`);
      assertPositivePgInteger(line.requestedPieces, `lines[${index}].requestedPieces`);
      assertOptionalCatalogText(line.vendorSku, `lines[${index}].vendorSku`, 100);
      assertOptionalCatalogText(line.quantityOverrideReason, `lines[${index}].quantityOverrideReason`, 2_000);
      const duplicateKey = `${line.vendorId}:${line.recommendationLineId}`;
      if (duplicateKeys.has(duplicateKey)) {
        throw new PurchasingError(`lines[${index}] duplicates a recommendation for the same supplier`, 400);
      }
      duplicateKeys.add(duplicateKey);
    }

    const writeTime = now();
    const { actorType, actorId } = resolveActor(userId);
    const normalizedRequestNote = input.requestNote?.trim() || null;
    const normalizedLines = input.lines.map((line) => ({
      ...line,
      vendorSku: line.vendorSku?.trim() || null,
      quantityOverrideReason: line.quantityOverrideReason?.trim() || null,
      allocationOverrideApproved: line.allocationOverrideApproved === true,
    }));
    const vendorIds = Array.from(new Set(normalizedLines.map((line) => line.vendorId)));
    const requestHash = buildRfqCreationRequestHash(input, actorType === "user" ? actorId : null);

    try {
      const work = async (tx: any) => {
        if (actorType !== "user" || !userId) throw new PurchasingError("An authenticated RFQ operator is required", 401, { code: "RFQ_ACTOR_REQUIRED" });
        await assertRfqCreationAuthorityInTransaction(tx, userId);
        const priorRfqs = await tx.select().from(requestForQuotesTable).where(
          eq(requestForQuotesTable.idempotencyKey, idempotencyKey),
        );
        if (priorRfqs.length > 0) {
          // Legacy RFQs predate the scoped command ledger. Their recorded
          // creator, never an inferred actor, owns recovery of the saved key.
          if (priorRfqs.some((rfq: any) => rfq.createdBy == null || rfq.createdBy !== userId)) {
            throw new PurchasingError("The saved RFQ request belongs to another operator or has no verified creator", 409, {
              code: "RFQ_IDEMPOTENCY_ACTOR_CONFLICT",
            });
          }
          if (
            priorRfqs.length !== vendorIds.length
            || priorRfqs.some((rfq: any) => !vendorIds.includes(Number(rfq.vendorId)))
            || priorRfqs.some((rfq: any) => rfq.requestHash !== requestHash)
          ) {
            throw new PurchasingError("The idempotency key was already used for a different RFQ request", 409, {
              code: "RFQ_IDEMPOTENCY_CONFLICT",
            });
          }
          const priorLines = await tx.select().from(requestForQuoteLinesTable).where(
            inArray(requestForQuoteLinesTable.rfqId, priorRfqs.map((rfq: any) => rfq.id)),
          );
          return { rfqs: priorRfqs, lines: priorLines, reused: true };
        }

        const vendorRows = await tx.select().from(vendorsTable).where(inArray(vendorsTable.id, vendorIds)).for("update");
        const vendorById = new Map(vendorRows.map((vendor: any) => [Number(vendor.id), vendor]));
        if (vendorRows.length !== vendorIds.length || vendorRows.some((vendor: any) => Number(vendor.active) !== 1)) {
          throw new PurchasingError("Every RFQ supplier must exist and be active", 409, {
            code: "RFQ_VENDOR_INACTIVE_OR_MISSING",
          });
        }

        const recommendationIds = Array.from(new Set(normalizedLines.map((line) => line.recommendationLineId)));
        const recommendationRows = await tx.select().from(purchaseRecommendationLinesTable).where(
          inArray(purchaseRecommendationLinesTable.id, recommendationIds),
        ).for("update");
        const recommendationById = new Map(recommendationRows.map((line: any) => [Number(line.id), line]));
        if (recommendationRows.length !== recommendationIds.length) {
          throw new PurchasingError("One or more recommendation lines no longer exist", 409, {
            code: "RFQ_RECOMMENDATION_MISSING",
          });
        }

        const allocatedBySku = await lockAndLoadActiveRfqAllocations(tx, recommendationRows);

        const grouped = new Map<number, PreparedRfqBatchLineInput[]>();
        for (const selection of normalizedLines) {
          const recommendation = recommendationById.get(selection.recommendationLineId) as any;
          if (!recommendation || recommendation.status !== "open") {
            throw new PurchasingError("A selected recommendation is no longer open", 409, {
              code: "RFQ_RECOMMENDATION_CLOSED",
              recommendationLineId: selection.recommendationLineId,
            });
          }
          const allocationKey = purchasingSkuAllocationKey(recommendation);
          const alreadyAllocated = allocatedBySku.get(allocationKey) ?? 0;
          const remainingPieces = Math.max(Number(recommendation.recommendedPieces) - alreadyAllocated, 0);
          const allocation = evaluateRfqAllocationOverride({
            requestedPieces: selection.requestedPieces,
            remainingPieces,
            quantityOverrideReason: selection.quantityOverrideReason,
            allocationOverrideApproved: selection.allocationOverrideApproved,
            approvedBy: actorType === "user" ? actorId : null,
            approvedAt: writeTime,
          });
          if (!allocation.ok) {
            throw new PurchasingError(allocation.issue.message, allocation.issue.statusCode, {
              code: allocation.issue.code,
              recommendationLineId: selection.recommendationLineId,
              recommendedPieces: recommendation.recommendedPieces,
              alreadyAllocated,
              ...allocation.issue.context,
            });
          }
          allocatedBySku.set(allocationKey, alreadyAllocated + selection.requestedPieces);
          const group = grouped.get(selection.vendorId) ?? [];
          group.push({
            ...selection,
            ...allocation.evidence,
            recommendedPieces: Number(recommendation.recommendedPieces),
            alreadyAllocatedPieces: alreadyAllocated,
          });
          grouped.set(selection.vendorId, group);
        }

        const createdRfqs: any[] = [];
        const createdLines: any[] = [];
        const auditRows: Array<Record<string, unknown>> = [];
        for (const [vendorId, selections] of grouped.entries()) {
          const insertedRfqs = await tx.insert(requestForQuotesTable).values({
            rfqNumber: `RFQ-${writeTime.toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`,
            vendorId,
            idempotencyKey,
            requestHash,
            status: "draft",
            requestNote: normalizedRequestNote,
            currency: String((vendorById.get(vendorId) as any)?.currency ?? "USD").toUpperCase(),
            responseDueDate: input.responseDueDate ?? null,
            createdBy: userId ?? null,
          }).returning();
          const rfq = insertedRfqs[0];
          if (!rfq) throw new PurchasingError("RFQ header was not created", 409);
          createdRfqs.push(rfq);

          for (const selection of selections) {
            const recommendation = recommendationById.get(selection.recommendationLineId) as any;
            const variantId = recommendation.productVariantId ?? null;
            await lockVendorProductReferences(tx, vendorId, Number(recommendation.productId), variantId);
            const mappingRows = await tx.select().from(vendorProductsTable).where(and(
              eq(vendorProductsTable.vendorId, vendorId),
              eq(vendorProductsTable.productId, Number(recommendation.productId)),
              selection.vendorProductId === undefined
                ? sql`COALESCE(${vendorProductsTable.productVariantId}, 0) = ${variantId ?? 0}`
                : and(eq(vendorProductsTable.id, selection.vendorProductId), sql`(${vendorProductsTable.productVariantId} IS NULL OR ${vendorProductsTable.productVariantId} = ${variantId})`),
            )).limit(1).for("update");
            const existingMapping = mappingRows[0] ?? null;
            let sourcingQuote: SupplierPriceList | null = null;
            if (selection.vendorProductId !== undefined) {
              if (!existingMapping || existingMapping.isActive !== 1) throw new PurchasingError("The selected supplier mapping is inactive or does not match this recommendation", 409, { code: "RFQ_SUPPLIER_MAPPING_CHANGED" });
              const policy = (await loadSupplierSourcingRecords(tx, [selection.vendorProductId])).get(selection.vendorProductId);
              sourcingQuote = policy?.policy.priceList ?? null;
              if (policy?.policy.eligibleForProposals === false) throw new PurchasingError("This supplier mapping is paused for proposals. Review its sourcing settings first.", 409, { code: "RFQ_SUPPLIER_PAUSED" });
            }
            const makePreferred = recommendation.preferredVendorId == null;
            if (makePreferred) {
              const demotions = await demoteCompetingPreferredMappings(tx, {
                vendorId,
                productId: Number(recommendation.productId),
                productVariantId: variantId,
                updatedAt: writeTime,
              });
              appendPreferredDemotionAudits(auditRows, demotions, actorType, actorId, {
                vendorId,
                productId: Number(recommendation.productId),
                productVariantId: variantId,
              }, "vendor_catalog.rfq_preferred_demoted");
            }

            let vendorProduct: any;
            let catalogAction: "created" | "updated";
            if (existingMapping) {
              const updated = await tx.update(vendorProductsTable).set({
                isActive: 1,
                ...(makePreferred ? { isPreferred: 1 } : {}),
                ...(selection.vendorSku !== undefined ? { vendorSku: selection.vendorSku?.trim() || null } : {}),
                updatedAt: writeTime,
              }).where(eq(vendorProductsTable.id, existingMapping.id)).returning();
              vendorProduct = updated[0];
              catalogAction = "updated";
            } else {
              const inserted = await tx.insert(vendorProductsTable).values({
                vendorId,
                productId: Number(recommendation.productId),
                productVariantId: variantId,
                vendorSku: selection.vendorSku?.trim() || null,
                unitCostCents: null,
                unitCostMills: null,
                pricingBasis: "legacy_unknown",
                isPreferred: makePreferred ? 1 : 0,
                isActive: 1,
              }).returning();
              vendorProduct = inserted[0];
              catalogAction = "created";
            }
            if (!vendorProduct) throw new PurchasingError("Supplier catalog mapping was not saved", 409);

            const purchaseUom = sourcingQuote ? sourcingQuote.purchaseUom : vendorProduct.purchaseUom ?? null;
            const piecesPerPurchaseUom = sourcingQuote ? sourcingQuote.piecesPerPurchaseUom : vendorProduct.piecesPerPurchaseUom ?? null;
            const insertedLines = await tx.insert(requestForQuoteLinesTable).values({
              rfqId: rfq.id,
              recommendationLineId: selection.recommendationLineId,
              vendorProductId: Number(vendorProduct.id),
              requestedPieces: selection.requestedPieces,
              status: "draft",
              quantityOverrideReason: selection.quantityOverrideReason,
              allocationOverrideReason: selection.allocationOverrideReason,
              allocationOverrideApprovedBy: selection.allocationOverrideApprovedBy,
              allocationOverrideApprovedAt: selection.allocationOverrideApprovedAt,
              allocationOverrideBaselinePieces: selection.allocationOverrideBaselinePieces,
              allocationOverrideExcessPieces: selection.allocationOverrideExcessPieces,
              purchaseUom,
              piecesPerPurchaseUom,
              requestedPurchaseUomQty: piecesPerPurchaseUom
                ? String(selection.requestedPieces / Number(piecesPerPurchaseUom))
                : null,
            }).returning();
            const rfqLine = insertedLines[0];
            if (!rfqLine) throw new PurchasingError("RFQ line was not created", 409);
            createdLines.push(rfqLine);
            if (selection.allocationOverrideExcessPieces) {
              auditRows.push({
                level: "AUDIT",
                actor: `${actorType}:${actorId}`,
                action: "purchase_rfq.allocation_override_approved",
                target: `request_for_quote_line:${rfqLine.id}`,
                changes: {
                  before: null,
                  after: {
                    recommendationLineId: recommendation.id,
                    recommendedPieces: selection.recommendedPieces,
                    alreadyAllocatedPieces: selection.alreadyAllocatedPieces,
                    requestedPieces: selection.requestedPieces,
                    excessPieces: selection.allocationOverrideExcessPieces,
                    reason: selection.allocationOverrideReason,
                    approvedBy: selection.allocationOverrideApprovedBy,
                    approvedAt: selection.allocationOverrideApprovedAt,
                  },
                },
                context: { rfqId: rfq.id, vendorId },
              });
            }
            auditRows.push({
              level: "AUDIT",
              actor: `${actorType}:${actorId}`,
              action: `vendor_catalog.rfq_${catalogAction}`,
              target: `vendor_product:${vendorProduct.id}`,
              changes: { before: existingMapping ? catalogAuditSnapshot(existingMapping) : null, after: catalogAuditSnapshot(vendorProduct) },
              context: { recommendationLineId: recommendation.id, rfqId: rfq.id, requestedPieces: selection.requestedPieces },
            });
          }
          auditRows.push({
            level: "AUDIT",
            actor: `${actorType}:${actorId}`,
            action: "purchase_rfq.batch_created",
            target: `request_for_quote:${rfq.id}`,
            changes: { before: null, after: { rfqNumber: rfq.rfqNumber, vendorId, lineCount: selections.length, status: "draft" } },
            context: { idempotencyKey, requestHash, request: {
              requestNote: normalizedRequestNote,
              responseDueDate: input.responseDueDate ?? null,
              // Each supplier event preserves its own selections. Together the
              // immutable events retain the original batch after ledger expiry.
              lines: selections.map(selection => ({ recommendationLineId: selection.recommendationLineId, vendorId,
                ...(selection.vendorProductId === undefined ? {} : { vendorProductId: selection.vendorProductId }),
                vendorSku: selection.vendorSku ?? null, requestedPieces: selection.requestedPieces,
                quantityOverrideReason: selection.quantityOverrideReason, allocationOverrideApproved: selection.allocationOverrideApproved === true })),
            } },
          });
        }
        if (auditRows.length > 0) await insertAuditEventDrizzle(tx, auditRows.map(row => ({ ...row, timestamp: writeTime })));
        return { rfqs: createdRfqs, lines: createdLines, reused: false };
      };
      return existingTransaction ? await work(existingTransaction) : await db.transaction(work);
    } catch (error: any) {
      if (error?.code === "23514" && String(error?.message ?? "").includes("RFQ_SUPPLY_SNAPSHOT_STALE")) {
        throw new PurchasingError("Purchase supply changed after this recommendation run. Generate fresh recommendations before creating another RFQ.", 409, { code: "RFQ_SUPPLY_SNAPSHOT_STALE" });
      }
      if (error?.code === "23514" && String(error?.message ?? "").includes("allocation exceeds")) {
        throw new PurchasingError("Another RFQ consumed some of this recommendation; refresh and try again", 409, {
          code: "RFQ_ALLOCATION_CONFLICT",
        });
      }
      rethrowVendorCatalogWriteError(error);
    }
  }

  async function assertRfqCreationAuthorityInTransaction(tx: RfqWorkflowTransaction, actorId: string): Promise<void> {
    await lockInventoryCostGraph(tx);
    const authority = await readCommandActor(tx, actorId);
    if (!authority.active || !authority.permissions.includes("purchasing:edit")) {
      throw new PurchasingError("Current unrestricted purchasing edit permission is required to create or recover an RFQ", 403, { code: "RFQ_CREATE_AUTHORITY_REQUIRED" });
    }
  }

  async function assertRfqCreationAuthority(actorId: string): Promise<void> {
    await db.transaction((tx: RfqWorkflowTransaction) => assertRfqCreationAuthorityInTransaction(tx, actorId));
  }

  async function createRfqBatchInTransaction(tx: RfqWorkflowTransaction, input: RfqCreatePayload, actorId: string, idempotencyKey: string) {
    return createRfqBatch({ ...input, idempotencyKey }, actorId, tx);
  }

  async function getNewPoPreload(params: {
    vendorId?: number;
    variantIds?: number[];
    duplicateFrom?: number;
  }): Promise<{
    vendor: any | null;
    lines: PreloadLine[];
    sourcePo: { poNumber: string; note: string } | null;
  }> {
    const { vendorId, variantIds, duplicateFrom } = params;

    // Duplicate path takes precedence: use source PO's vendor + lines.
    if (duplicateFrom !== undefined) {
      const source = await storage.getPurchaseOrderById(duplicateFrom);
      if (!source) throw new PurchasingError("Source purchase order not found", 404);
      const [vendor, srcLines] = await Promise.all([
        storage.getVendorById(source.vendorId),
        storage.getPurchaseOrderLines(duplicateFrom),
      ]);
      const lines: PreloadLine[] = [];
      for (const src of srcLines) {
        if (src.status === "cancelled") continue;
        const sourceReceiveVariantId = src.expectedReceiveVariantId ?? src.productVariantId ?? null;
        const sourceReceiveVariant = sourceReceiveVariantId == null
          ? null
          : await storage.getProductVariantById(sourceReceiveVariantId);
        const activeSourceReceiveVariant =
          sourceReceiveVariant &&
          sourceReceiveVariant.isActive !== false &&
          Number(sourceReceiveVariant.productId) === Number(src.productId)
            ? sourceReceiveVariant
            : null;
        // Source priority (duplicate path):
        //   source line.unit_cost_mills → centsToMills(source line.unit_cost_cents)
        //   overridden by matching vendor_products.unit_cost_mills / cents.
        let unitCostMills: number =
          typeof src.unitCostMills === "number" && src.unitCostMills >= 0
            ? src.unitCostMills
            : centsToMills(readIntegerCents(src.unitCostCents ?? 0, "unit cost", true));
        let catalogSource: PreloadLine["catalogSource"] = "duplicate";
        let vendorProductId: number | null = src.vendorProductId ?? null;
        let pricingBasis: PreloadLine["pricingBasis"] =
          src.pricingBasis === "per_piece" || src.pricingBasis === "per_purchase_uom"
            ? src.pricingBasis
            : "legacy_unknown";
        let purchaseUom: string | null = src.purchaseUom ?? null;
        let quotedUnitCostMills: number | null = src.quotedUnitCostMills ?? null;
        let piecesPerPurchaseUom: number | null = src.piecesPerPurchaseUom ?? null;
        let quoteReference: string | null = src.quoteReference ?? null;
        let quotedAt: Date | null = src.quotedAt ?? null;
        let quoteValidUntil: string | null = src.quoteValidUntil ?? null;
        try {
          const vp = await storage.getPreferredVendorProduct(
            src.productId,
            sourceReceiveVariantId ?? undefined,
          );
          if (vp && vp.vendorId === source.vendorId) {
            if (typeof vp.unitCostMills === "number" && vp.unitCostMills >= 0) {
              unitCostMills = vp.unitCostMills;
              catalogSource = "vendor_catalog";
            } else if (typeof vp.unitCostCents === "number") {
              unitCostMills = centsToMills(vp.unitCostCents);
              catalogSource = "vendor_catalog";
            }
            vendorProductId = vp.id ?? null;
            pricingBasis =
              vp.pricingBasis === "per_piece" || vp.pricingBasis === "per_purchase_uom"
                ? vp.pricingBasis
                : "legacy_unknown";
            purchaseUom = vp.purchaseUom ?? null;
            quotedUnitCostMills = vp.quotedUnitCostMills ?? null;
            piecesPerPurchaseUom = vp.piecesPerPurchaseUom ?? null;
            quoteReference = vp.quoteReference ?? null;
            quotedAt = vp.quotedAt ?? null;
            quoteValidUntil = vp.quoteValidUntil ?? null;
          }
        } catch {
          // non-fatal
        }
        lines.push({
          productId: src.productId,
          productVariantId: activeSourceReceiveVariant?.id ?? null,
          expectedReceiveVariantId: activeSourceReceiveVariant?.id ?? null,
          expectedReceiveUnitsPerVariant: activeSourceReceiveVariant
            ? src.expectedReceiveUnitsPerVariant ?? src.unitsPerUom ?? activeSourceReceiveVariant.unitsPerVariant ?? 1
            : 1,
          productName: src.productName ?? "",
          sku: src.sku ?? null,
          variantDescription: null,
          uomLabel: src.unitOfMeasure ?? null,
          suggestedQty: src.orderQty,
          unitCostCents: millsToCents(unitCostMills),
          unitCostMills,
          catalogSource,
          vendorProductId,
          pricingBasis,
          purchaseUom,
          quotedUnitCostMills,
          piecesPerPurchaseUom,
          quoteReference,
          quotedAt,
          quoteValidUntil,
        });
      }
      return {
        vendor: vendor ?? null,
        lines,
        sourcePo: {
          poNumber: source.poNumber,
          note: `Duplicated from ${source.poNumber}`,
        },
      };
    }

    const vendor = vendorId ? await storage.getVendorById(vendorId) : null;

    const lines: PreloadLine[] = [];
    if (Array.isArray(variantIds) && variantIds.length > 0) {
      for (const vid of variantIds) {
        if (!Number.isInteger(vid) || vid <= 0) continue;
        const variant = await storage.getProductVariantById(vid);
        if (!variant) continue;
        const product = await storage.getProductById(variant.productId);
        if (!product) continue;
        const activeReceiveVariant = variant.isActive === false ? null : variant;
        // Source priority (variant path) per spec:
        //   vendor_products.unit_cost_mills
        //   → centsToMills(vendor_products.unit_cost_cents)
        //   → centsToMills(variant.standardCostCents)
        //   → centsToMills(variant.lastCostCents)
        //   → 0
        let unitCostMills: number = centsToMills(
          readIntegerCents(variant.standardCostCents ?? variant.lastCostCents ?? 0, "unit cost", true),
        );
        let catalogSource: PreloadLine["catalogSource"] = "product_default";
        let vendorProductId: number | null = null;
        let pricingBasis: PreloadLine["pricingBasis"] = "legacy_unknown";
        let purchaseUom: string | null = null;
        let quotedUnitCostMills: number | null = null;
        let piecesPerPurchaseUom: number | null = null;
        let quoteReference: string | null = null;
        let quotedAt: Date | null = null;
        let quoteValidUntil: string | null = null;
        if (vendorId) {
          try {
            const vp = await storage.getPreferredVendorProduct(product.id, variant.id);
            if (vp && vp.vendorId === vendorId) {
              if (typeof vp.unitCostMills === "number" && vp.unitCostMills >= 0) {
                unitCostMills = vp.unitCostMills;
                catalogSource = "vendor_catalog";
              } else if (typeof vp.unitCostCents === "number") {
                unitCostMills = centsToMills(vp.unitCostCents);
                catalogSource = "vendor_catalog";
              }
              vendorProductId = vp.id ?? null;
              pricingBasis =
                vp.pricingBasis === "per_piece" || vp.pricingBasis === "per_purchase_uom"
                  ? vp.pricingBasis
                  : "legacy_unknown";
              purchaseUom = vp.purchaseUom ?? null;
              quotedUnitCostMills = vp.quotedUnitCostMills ?? null;
              piecesPerPurchaseUom = vp.piecesPerPurchaseUom ?? null;
              quoteReference = vp.quoteReference ?? null;
              quotedAt = vp.quotedAt ?? null;
              quoteValidUntil = vp.quoteValidUntil ?? null;
            }
          } catch {
            // non-fatal
          }
        }
        lines.push({
          productId: product.id,
          productVariantId: activeReceiveVariant?.id ?? null,
          expectedReceiveVariantId: activeReceiveVariant?.id ?? null,
          expectedReceiveUnitsPerVariant: activeReceiveVariant?.unitsPerVariant || 1,
          productName: product.name ?? "",
          sku: product.sku ?? variant.sku ?? null,
          variantDescription: activeReceiveVariant?.name ?? null,
          uomLabel: activeReceiveVariant?.name?.split(" ")[0]?.toLowerCase() ?? null,
          // No reorder_quantity column today. Default to 1 so the row is
          // usable; users edit qty in the lines editor.
          suggestedQty: 1,
          unitCostCents: millsToCents(unitCostMills),
          unitCostMills,
          catalogSource,
          vendorProductId,
          pricingBasis,
          purchaseUom,
          quotedUnitCostMills,
          piecesPerPurchaseUom,
          quoteReference,
          quotedAt,
          quoteValidUntil,
        });
      }
    }

    return { vendor, lines, sourcePo: null };
  }

  // ── ON-ORDER QUERY ──────────────────────────────────────

  async function getOnOrderQty(productVariantId: number): Promise<{
    onOrderQty: number;
    openPoCount: number;
    earliestExpectedDate: Date | null;
  }> {
    const openLines = await storage.getOpenPoLinesForVariant(productVariantId);
    let total = 0;
    let earliestDate: Date | null = null;
    const poIds = new Set<number>();

    for (const line of openLines) {
      const remaining = line.orderQty - (line.receivedQty || 0) - (line.cancelledQty || 0);
      if (remaining > 0) {
        total += remaining;
        poIds.add(line.purchaseOrderId);

        const lineDate = line.expectedDeliveryDate || line.promisedDate;
        if (lineDate && (!earliestDate || lineDate < earliestDate)) {
          earliestDate = lineDate;
        }
      }
    }

    return {
      onOrderQty: total,
      openPoCount: poIds.size,
      earliestExpectedDate: earliestDate,
    };
  }

  return {
    snapshotPurchaseRecommendations,
    createRfqBatch,
    createRfqBatchInTransaction,
    assertRfqCreationAuthority,
    getNewPoPreload,
    getOnOrderQty,
  };
}
